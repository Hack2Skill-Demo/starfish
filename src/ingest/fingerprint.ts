import { createHash } from "node:crypto";

/**
 * Stable dedup key for an error.
 *
 * Derived from the function name plus the first 100 characters of the lowercased
 * message, so the same recurring failure hashes identically across runs. The
 * 100-char cut matters: error messages routinely carry a varying tail (an id, a
 * timestamp, a retry count) that would otherwise make every occurrence look like
 * a brand-new incident.
 *
 * Inputs are coerced because this also runs against documents read back out of
 * Firestore, where a legacy or malformed row must not crash a whole batch. Valid
 * string inputs are unaffected, so fingerprints already stored stay stable.
 */
export function computeErrorFingerprint(functionName: string, errorMessage: string): string {
  const normalizedFn = String(functionName ?? "");
  const normalizedMessage = String(errorMessage ?? "").substring(0, 100).toLowerCase();
  return createHash("sha256")
    .update(`${normalizedFn}:${normalizedMessage}`)
    .digest("hex")
    .substring(0, 16);
}
