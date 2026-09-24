const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Hard cap on text handed to the model, independent of what redaction catches. */
export const MAX_TEXT_LEN = 4000;

/**
 * Strip the PII we can reliably pattern-match before an error message or stack
 * reaches the model.
 *
 * Emails are the one dependably detectable case in error text. Free-form PII —
 * names, addresses, record ids — is not pattern-detectable, which is exactly why
 * `truncate` exists alongside this: bounding how much raw production text leaves
 * the system at all is the guard that doesn't depend on a regex being clever.
 */
export function redactPii(text: string): string {
  return String(text ?? "").replace(EMAIL_RE, "[redacted-email]");
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
