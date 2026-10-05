/**
 * Links from an outside message (Slack, a GitHub issue) back to the operator UI. Built here, once, from the
 * configured UI origin and an id that is checked to be a plain id, so text from an incident can never become part of
 * a link. No origin configured: no link.
 */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function incidentUrl(uiBaseUrl: string, incidentId: string): string | null {
  return uiBaseUrl !== "" && PLAIN_ID.test(incidentId) ? `${uiBaseUrl}/incidents/${incidentId}` : null;
}

export function runUrl(uiBaseUrl: string, cycleId: string): string | null {
  return uiBaseUrl !== "" && PLAIN_ID.test(cycleId) ? `${uiBaseUrl}/runs?run=${cycleId}` : null;
}

/** An https URL with no credentials (what GitHub's API returns as `html_url`), or null. For a link in a message. */
export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}
