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
 * VALUE is replaced, so the URL stays readable.
 */
const URL_CREDENTIAL_PARAM_RE =
  /([?&](?:token|access_token|id_token|refresh_token|api_key|apikey|key|sig|signature|x-goog-signature|x-goog-credential|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s#"'<>)\]]+/gi;

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

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * `password: hunter2`, `api_key=abc`, `"token":"abc"` — name and separator kept,
 * value dropped. Narrower than `SENSITIVE_KEY_RE` on purpose: this runs over free
 * text, where a bare `auth` substring would mangle "Unauthorized: invalid grant"
 * (and move its fingerprint). The name must be followed directly by `:` or `=`. Whatever precedes
 * the keyword in the name (`x-api-token`, `db.password`) stays in the text untouched, so the match
 * need not, and must not (#96), scan backwards over it.
 */
const KEY_VALUE_RE =
  /(["']?(?:token|secret|passw(?:or)?d|api[-_]?key|authorization|cookie|credentials?|private[-_]?key|access[-_]?key|signature)["']?\s*[:=]\s*)(?!\[redacted-)(?:"[^"]*"|'[^']*'|[^\s,;&"'}\])]+)/gi;

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
 * pairs (shapes first, so "Authorization: Bearer abc" loses the whole credential),
 * and emails. Idempotent, so it is safe to apply at several layers: the store
 * re-applies it to whatever a caller hands it.
 */
export function redactPii(text: string): string {
  const out = redactCredentials(text).replace(KEY_VALUE_RE, `$1${SECRET_MARKER}`);
  return redactEmails(out);
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

export function truncate(text: string, max = MAX_TEXT_LEN): string {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** Redact then bound, in that order. */
export function sanitize(text: string | undefined, max = MAX_TEXT_LEN): string | undefined {
  if (text == null) return undefined;
  return truncate(redactPii(text), max);
}
