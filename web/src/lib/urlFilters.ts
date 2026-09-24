/**
 * URL filter helpers
 * ============================================================================
 * Utilities for reading filter/search state out of URL search params. Search
 * params are untrusted input — a hand-edited, stale, or shared link can carry
 * any string — so values bound to a fixed set (e.g. a status `<select>`) must
 * be narrowed before use. An unrecognized value would otherwise become an
 * invalid controlled `<select>` value (React controlled/uncontrolled warning)
 * and silently filter the list down to nothing.
 */

/**
 * Narrows an untrusted URL param to one of a known set of values, falling back
 * to "" (the "all" / cleared state) when it isn't recognized.
 *
 * @param raw     The raw param value (e.g. `searchParams.get("status")`).
 * @param allowed The set of valid values for this filter.
 */
export function asFilterValue<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | "" {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : "";
}
