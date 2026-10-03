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
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const SECRET_MARK = "[redacted-secret]";

/** PEM blocks (private keys, certificates' keys), including a block cut off by truncation. */
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** `scheme://user:password@host` — the credential in a connection string or URL. */
const URL_CREDENTIAL_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

/**
 * Names of fields that hold a credential. Used both to drop structured fields and
 * to find `name=value` / `"name":"value"` pairs inside free text. Deliberately
 * broad: redacting a harmless field costs a little context, leaking one costs a
 * credential. `key$` catches accessKey/privateKey/signingKey without matching
 * every field that merely contains "key".
 */
const SENSITIVE_KEY_RE =
  /token|secret|passw|auth|api[-_]?key|key$|cookie|credential|jwt|bearer|signature|session/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/** `password: hunter2`, `api_key=abc`, `"token":"abc"` — name and separator kept, value dropped. */
const KEY_VALUE_RE =
  /(["']?[\w.-]*(?:token|secret|passw(?:or)?d|passwd|api[-_]?key|apikey|auth(?:orization)?|cookie|credential|private[-_]?key|access[-_]?key|client[-_]?secret|signature)[\w.-]*["']?\s*[:=]\s*)(?!\[redacted-)(?:"[^"]*"|'[^']*'|[^\s,;&"'}\])]+)/gi;

/**
 * Values whose shape alone identifies them. Prefixes distinctive enough on their
 * own (`ghp_`, `AIza`, `xoxb-`) carry no leading `\b`: a token glued to a word
 * character ("tok_ghp_…") must not survive for want of a word boundary.
 */
const SECRET_VALUE_RES: RegExp[] = [
  // JWT
  /\beyJ[\w-]{8,}\.[\w-]+\.[\w-]*/g,
  // Authorization header values
  /\bBearer\s+[\w.~+/-]{8,}=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]{12,}=*/g,
  // Google API key, OAuth access / refresh tokens
  /AIza[\w-]{30,}/g,
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

/** Hard cap on text handed to the model, independent of what redaction catches. */
export const MAX_TEXT_LEN = 4000;

/** Credentials only: private keys, URL credentials, key=value pairs, token shapes. */
export function redactSecrets(text: string): string {
  let out = String(text ?? "")
    .replace(PRIVATE_KEY_RE, SECRET_MARK)
    .replace(URL_CREDENTIAL_RE, `$1${SECRET_MARK}@`);
  // Shapes before key=value: "Authorization: Bearer abc" must lose the whole
  // credential, not just the word "Bearer".
  for (const re of SECRET_VALUE_RES) out = out.replace(re, SECRET_MARK);
  return out.replace(KEY_VALUE_RE, `$1${SECRET_MARK}`);
}

/**
 * Credentials and the PII we can reliably pattern-match (emails). Idempotent, so
 * it is safe to apply at several layers: the store re-applies it to whatever a
 * caller hands it, and a record that was already clean comes back unchanged.
 */
export function redact(text: string): string {
  return redactSecrets(text).replace(EMAIL_RE, "[redacted-email]");
}

export function truncate(text: string, max = MAX_TEXT_LEN): string {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** Redact then bound, in that order. */
export function sanitize(text: string | undefined, max = MAX_TEXT_LEN): string | undefined {
  if (text == null) return undefined;
  return truncate(redact(text), max);
}
