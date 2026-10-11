/**
 * The one redaction policy. Every path that persists incident text or sends it
 * out of the process — the store, the model context, model error reporting,
 * spike output, and later issues/PRs and Slack — goes through this file, so a
 * secret caught in one place is caught in all of them.
 *
 * Two layers, because neither is enough alone:
 *  - VALUES that look like credentials, wherever they sit (a token in a message,
 *    a stack frame, a URL, a JSON dump). Key names are a convention; shapes are not.
 *  - KEYS that name a credential, for structured fields where the value has no
 *    recognisable shape (a bare password).
 *
 * This is pattern matching and will miss novel formats. Free-form PII — names,
 * addresses, record ids — is not pattern-detectable at all, which is why
 * `truncate` exists alongside: bounding how much raw production text leaves the
 * system is the guard that doesn't depend on a regex being clever.
 */
// Time, not matching, shapes several patterns in this file: a regex with an unbounded run in front
// of its anchor (`[\w.-]*token`, `[a-z0-9]+@`) rescans the rest of a long run from every character
// it could start at, which is quadratic (100 KB of one character took ~10 s and blocked the event
// loop, #96). Each such pattern below is anchored on its distinctive part instead.
/** The domain half of an address; `redactEmails` walks left from it over the local part. */
const EMAIL_DOMAIN_RE = /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_LOCAL_CHAR_RE = /[A-Za-z0-9._%+-]/;

/** Hard cap on text handed to the model, independent of what redaction catches. */
export const MAX_TEXT_LEN = 4000;

const SECRET_MARKER = "[redacted-secret]";

/** `Bearer <token>` (an Authorization header value), whatever token follows. */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
/** A JWT: three base64url segments, the first a `{"…` JSON header (`eyJ`). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
/** A Google API key: `AIza` plus base64url. `{35,}` so a longer token is redacted whole. */
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{35,}/g;
/**
 * A credential carried in a URL query parameter: a Firebase Storage download
 * `token`, an OAuth `access_token`, a signed-URL signature, an API `key`. Only the
 * VALUE is replaced, so the URL stays readable. `(?!\[redacted-)`, as in `KEY_VALUE_RE`: the value
 * class accepts `[`, so without it a second pass read `[redacted-secret` as a value and appended a `]`
 * each time, which moved the fingerprint `pnpm scrub` recomputes and forked the incident (#128).
 */
const URL_CREDENTIAL_PARAM_RE =
  /([?&](?:token|access_token|id_token|refresh_token|api_key|apikey|key|sig|signature|x-goog-signature|x-goog-credential|x-amz-signature|x-amz-credential|x-amz-security-token)=)(?!\[redacted-)[^&\s#"'<>)\]]+/gi;

/** PEM blocks (private keys), including one cut off by truncation before its END line. */
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/**
 * `scheme://user:password@host` — the credential in a connection string or URL. The scheme is
 * bounded (RFC 3986 imposes no limit, but none in use is near 32): unbounded, it was rescanned from
 * every boundary in a long `a.a.a.…` run.
 */
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

/**
 * Other formats whose shape alone identifies them. Prefixes distinctive enough on
 * their own (`ghp_`, `xoxb-`) carry no leading `\b`: a token glued to a word
 * character ("tok_ghp_…") must not survive for want of a word boundary.
 */
const OTHER_TOKEN_RES: RegExp[] = [
  // Google OAuth access / refresh tokens
  /ya29\.[\w.-]{20,}/g,
  /\b1\/\/[\w-]{30,}/g,
  // GitHub tokens
  /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  // AWS access key id
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Slack tokens and webhook URLs
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[\w/]+/g,
  // Stripe-style secret / restricted keys
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // npm, SendGrid
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/g,
];

/**
 * Names of fields that hold a credential, for dropping structured fields.
 * Deliberately broad: dropping a harmless field costs a little context, leaking
 * one costs a credential. `key$` catches accessKey/privateKey/signingKey without
 * matching every field that merely contains "key".
 */
const SENSITIVE_KEY_RE =
  /token|secret|passw|auth|api[-_]?key|key$|cookie|credential|jwt|bearer|signature|session/i;
/**
 * The short names (`pass`, `pwd`, `sid`, `otp`) as a whole name or its last part (`db_pass`, `userPwd`), never inside
 * a word (`bypass`, `passes`): case-sensitive, like `SHORT_KEY_VALUE_RE` below (#298).
 */
const SHORT_SENSITIVE_KEY_RE = /(?:(?<![A-Za-z0-9])(?:pass|pwd|sid|otp|PASS|PWD|SID|OTP)|(?<![A-Z0-9])(?:Pass|Pwd|Sid|Otp))$/;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key) || SHORT_SENSITIVE_KEY_RE.test(key);
}

/**
 * The value half of a `key: value` pair: a double-quoted string, also in escaped JSON (`\"hunter2\"`, what a JSON
 * dump logged inside a string looks like: `parseLogEntry` stringifies a payload with no message), a single-quoted
 * string, or a bare run up to a delimiter. `[^"]*` stops at the first quote, so the escaped form ends on its `\"`
 * with no backtracking.
 */
const KV_VALUE = String.raw`(?:\\?"[^"]*"|'[^']*'|[^\s,;&"'}\])]+)`;
/** The quote after a key name: none, `"`, `'`, or an escaped `\"`. */
const KV_KEY_QUOTE = String.raw`(?:\\?["'])?`;

/**
 * `password: hunter2`, `api_key=abc`, `"token":"abc"`, `{\"password\":\"abc\"}` — name and separator kept,
 * value dropped. Narrower than `SENSITIVE_KEY_RE` on purpose: this runs over free
 * text, where a bare `auth` substring would mangle "Unauthorized: invalid grant"
 * (and move its fingerprint). The name must be followed directly by `:` or `=`. Whatever precedes
 * the keyword in the name (`x-api-token`, `db.password`) stays in the text untouched, so the match
 * need not, and must not (#96), scan backwards over it.
 */
const KEY_VALUE_RE = new RegExp(
  String.raw`(["']?(?:token|secret|passw(?:or)?d|api[-_]?key|credentials?|private[-_]?key|access[-_]?key|signature|session(?:[-_]?id)?)` +
    String.raw`${KV_KEY_QUOTE}\s*[:=]\s*)(?!\[redacted-)${KV_VALUE}`,
  "gi"
);

/**
 * Short credential names (`pass`, `pwd`, `sid`, `otp`), which as substrings sit inside ordinary words (`bypass`,
 * `compass`): each must start a name or a camelCase part (`db_pass`, `connect.sid`, `userPwd`), so this pattern is
 * case-sensitive and spells each casing out. A one-character lookbehind, not a backward scan (#96).
 */
const SHORT_KEY_VALUE_RE = new RegExp(
  String.raw`((?:(?<![A-Za-z0-9])(?:pass|pwd|sid|otp|PASS|PWD|SID|OTP)|(?<![A-Z0-9])(?:Pass|Pwd|Sid|Otp))` +
    String.raw`${KV_KEY_QUOTE}\s*[:=]\s*)(?!\[redacted-)${KV_VALUE}`,
  "g"
);

/**
 * An `Authorization` header: the scheme word AND its credential (`Basic dXNlcjpw…`, `Digest …`). As a plain
 * credential key only the scheme word was dropped, and the base64 `user:password` after it survived (#298). A
 * Bearer value is already gone by the time this runs (`BEARER_RE`). The scheme is optional (`Authorization: abc123`
 * is a bare token) and bounded, so a failed attempt backtracks over at most 32 characters.
 */
const AUTHORIZATION_RE = new RegExp(
  String.raw`(?<![\w-])(["']?(?:proxy-)?authorization${KV_KEY_QUOTE}\s*[:=]\s*)(?!\[redacted-)` +
    String.raw`(?:\\?"[^"]*"|'[^']*'|(?:[A-Za-z][\w-]{0,31}[ \t]+(?!\[redacted-))?[^\s,;&"'}\])]+)`,
  "gi"
);

/**
 * A `Cookie` / `Set-Cookie` header: every cookie in it, to the end of the line. Its value is `a=1; b=2`, so a value
 * that stopped at `;` kept every cookie after the first, a session cookie among them (#298). A quoted value (a JSON
 * dump) ends at its closing quote instead. `[ \t]*`, not `\s*`: a `Cookie:` that ends a line must not take the next.
 * The bare value starts on a non-space, so the spaces cannot be given back to it to slip past `(?!\[redacted-)` on
 * a second pass.
 */
const COOKIE_RE = new RegExp(
  String.raw`(?<![\w-])(["']?(?:set-)?cookie${KV_KEY_QUOTE}\s*[:=][ \t]*)(?!\[redacted-)(?:\\?"[^"]*"|'[^']*'|\S[^\r\n]*)`,
  "gi"
);

/**
 * A phone number written internationally (#298): `+`, a country code that does not start with 0, and 8 to 15 digits
 * in all (E.164's maximum), split by single spaces or dashes, optionally with a parenthesised area code. Narrow on
 * purpose: the `+` is required (a bare digit run is an id, a port or a count), a `.` never separates (an IP address or
 * a version), and nothing word-like may touch either end, so `+0000` and `+05:30` (time zone offsets),
 * `1.0.0+20130313144700` (build metadata) and a longer digit run are left alone. Each repetition consumes exactly one
 * digit, so a failed attempt backtracks over at most 15 of them (#96).
 */
const PHONE_RE = /(?<![\w+])\+[1-9](?:[ -]?\(?\d\)?){7,14}(?![\w-])/g;

/**
 * Redact credential-shaped VALUES: bearer tokens, JWTs, Google API keys, other
 * well-known token formats, private keys, URL userinfo and credential-carrying URL
 * query parameters. Key-name filtering can't catch these on its own: a token logged
 * under an innocent key, or inside a message, reads as ordinary text. Bearer runs
 * before JWT so `Bearer eyJ…` collapses to one marker.
 *
 * Shapes only — safe over source code, where `token = getToken()` is an
 * assignment, not a leak. `redactPii` adds the key=value rule for log text.
 */
export function redactCredentials(text: string): string {
  let out = String(text ?? "")
    .replace(PRIVATE_KEY_RE, SECRET_MARKER)
    .replace(URL_USERINFO_RE, `$1${SECRET_MARKER}@`)
    .replace(URL_CREDENTIAL_PARAM_RE, `$1${SECRET_MARKER}`)
    .replace(BEARER_RE, SECRET_MARKER)
    .replace(JWT_RE, SECRET_MARKER)
    .replace(GOOGLE_API_KEY_RE, SECRET_MARKER);
  for (const re of OTHER_TOKEN_RES) out = out.replace(re, SECRET_MARKER);
  return out;
}

/**
 * Strip the PII and credentials we can reliably pattern-match before incident text
 * is stored or reaches the model: credential shapes, credential-named `key=value`
 * pairs (shapes first, so "Authorization: Bearer abc" loses the whole credential), the whole value of
 * an Authorization or Cookie header, emails, and phone numbers written with a `+` country code.
 * Idempotent, so it is safe to apply at several layers: the store re-applies it to whatever a caller
 * hands it.
 */
export function redactPii(text: string): string {
  const out = redactCredentials(text)
    .replace(AUTHORIZATION_RE, `$1${SECRET_MARKER}`)
    .replace(COOKIE_RE, `$1${SECRET_MARKER}`)
    .replace(KEY_VALUE_RE, `$1${SECRET_MARKER}`)
    .replace(SHORT_KEY_VALUE_RE, `$1${SECRET_MARKER}`);
  // Emails before phones: `bob+15551234567@example.com` is one address, not a number.
  return redactEmails(out).replace(PHONE_RE, "[redacted-phone]");
}

/**
 * `local@domain.tld` -> `[redacted-email]`. Finds each `@domain.tld` and extends left over the local
 * part, never past the end of the previous match, so the work is linear in the text (see above).
 */
function redactEmails(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(EMAIL_DOMAIN_RE)) {
    let start = m.index;
    while (start > last && EMAIL_LOCAL_CHAR_RE.test(text[start - 1]!)) start--;
    if (start === m.index) continue; // no local part: not an address
    out += text.slice(last, start) + "[redacted-email]";
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/**
 * The first `max` UTF-16 units of `s`, one fewer when the cut would split a surrogate pair. A lone
 * high surrogate is not valid UTF-8, so Firestore rejected the write; the window holding it was
 * replayed and rejected on every run, and ingest never got past it (#126). Every bounded slice of
 * text that is stored goes through here.
 */
export function sliceWellFormed(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = max > 0 && isHighSurrogate(s.charCodeAt(max - 1)) ? max - 1 : max;
  return s.slice(0, Math.max(0, end));
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `s` with every lone surrogate replaced by U+FFFD (`String.prototype.toWellFormed`, which ES2023's
 * lib does not type). For text that arrives as parsed JSON (an API body), where `"\ud83d"` is legal
 * and Firestore would reject it; Cloud Logging text is decoded UTF-8 and cannot carry one.
 */
export function toWellFormed(s: string): string {
  return s.replace(LONE_SURROGATE_RE, "�");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function truncate(text: string, max = MAX_TEXT_LEN): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const kept = sliceWellFormed(s, max);
  return `${kept}\n…[truncated ${s.length - kept.length} chars]`;
}

/**
 * Redact, then cut to at most `max` UTF-16 units, well-formed: a lone surrogate the text already held (model output is
 * parsed JSON, where one is legal) becomes U+FFFD, and the cut never splits a pair (#126, #183). For short text that is
 * stored or shown as is, with no truncation note.
 */
export function clipWellFormed(text: string, max: number): string {
  return sliceWellFormed(toWellFormed(redactPii(String(text))), max);
}

/** Redact then bound, in that order. */
export function sanitize(text: string | undefined, max = MAX_TEXT_LEN): string | undefined {
  if (text == null) return undefined;
  return truncate(redactPii(text), max);
}
