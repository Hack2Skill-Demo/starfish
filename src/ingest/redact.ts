const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Hard cap on text handed to the model, independent of what redaction catches. */
export const MAX_TEXT_LEN = 4000;

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

const SECRET_MARKER = "[redacted-secret]";

/**
 * Redact credential-shaped VALUES: bearer tokens, JWTs, Google API keys and
 * credential-carrying URL query parameters. Key-name filtering can't catch these
 * on its own: a token logged under an innocent key, or inside a message, reads as
 * ordinary text. Bearer runs before JWT so `Bearer eyJ…` collapses to one marker.
 */
export function redactCredentials(text: string): string {
  return String(text ?? "")
    .replace(URL_CREDENTIAL_PARAM_RE, `$1${SECRET_MARKER}`)
    .replace(BEARER_RE, SECRET_MARKER)
    .replace(JWT_RE, SECRET_MARKER)
    .replace(GOOGLE_API_KEY_RE, SECRET_MARKER);
}

/**
 * Strip the PII and credentials we can reliably pattern-match before an error
 * message or stack is stored or reaches the model.
 *
 * Emails and credential-shaped values are the dependably detectable cases in error
 * text. Free-form PII — names, addresses, record ids — is not pattern-detectable,
 * which is exactly why `truncate` exists alongside this: bounding how much raw
 * production text leaves the system at all is the guard that doesn't depend on a
 * regex being clever.
 */
export function redactPii(text: string): string {
  return redactCredentials(text).replace(EMAIL_RE, "[redacted-email]");
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
