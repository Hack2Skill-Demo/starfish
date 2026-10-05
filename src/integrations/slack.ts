/**
 * Slack delivery (#17): the "needs a human" message, posted to ONE channel through an incoming webhook, and nothing else.
 * A cycle that ends waiting for a person (triage said notify, the fixer declined, the verify gate or the review would
 * not pass a second time) says so in Slack with the reason and links back to the incident and its run.
 *
 * What it will not do:
 *   - Throw. A message that cannot be delivered is a RESULT (`failed`, with a short reason), because the cycle's
 *     own outcome must not depend on Slack being up; the loop records the result so a failed delivery is visible,
 *     never silent.
 *   - Retry without bound. At most `maxAttempts` posts; a network error, a timeout, a 429 (waiting what Slack asks,
 *     capped) and a 5xx are retried, any other refusal (a revoked webhook, an archived channel, a bad payload) is
 *     terminal at once, because repeating it cannot succeed.
 *   - Let incident text steer the message. Every dynamic field is redacted (redactPii) and cut, and goes into a
 *     `plain_text` block, which Slack does not parse for mentions, links or markup; the fallback text is sent with
 *     `mrkdwn: false`. Only the two links are markup, and they are built here from the configured UI origin and an id
 *     that is checked to be a plain id.
 *   - Reveal the webhook. The URL is the credential (anyone holding it can post to the channel). It is never put in
 *     an error, a log line or the result; a failure's `reason` is a status class and, at most, Slack's own short
 *     error code (`invalid_token`, `channel_is_archived`).
 *
 * Delivery is at-least-once, not exactly-once: Slack webhooks have no idempotency key, so a worker that crashes
 * between the post and recording it will post again on resume. The loop (loop.ts) records `pending` before and
 * `sent`/`failed` after and does not resend a recorded one; the gap in between is the duplicate we accept, since a
 * missed escalation is worse than a repeated one.
 *
 * Not built: the other two channels in the design (`#ops-alerts` for a new incident, `#ops-log` for a merged fix
 * and healed), the phone escalation (#37), and a message for an incident Starfish merely acts on. Never run against
 * real Slack: tested over local HTTP against a fake webhook.
 */
import { redactPii } from "../ingest/redact.js";
import { incidentUrl, runUrl, safeHttpsUrl } from "./links.js";

/** What the message is about. Built by the loop from the cycle and the stored incident, never from raw logs. */
export interface NotifyRequest {
  cycleId: string;
  incidentId: string;
  functionName: string;
  service: string;
  errorType: string;
  /** null when the stored incident has no count: the message then says nothing about how often, never "0 times". */
  occurrenceCount: number | null;
  /** `notify`: no code change helps. `human`: a patch was tried and a person has to take over. */
  path: "notify" | "human";
  /** The rule that ended the cycle, e.g. `verify-tests-failed`. */
  rule: string;
  /** One sentence for a person: why this needs them. Redacted and cut here. */
  reason: string;
  /** The incident's GitHub issue (#17), when one was filed: a third link on the message. */
  issueUrl?: string;
}

export interface DeliveryResult {
  state: "sent" | "failed";
  attempts: number;
  /** Present on a failure: what happened, safe to store and show. */
  reason?: string;
}

export interface SlackDeps {
  webhookUrl: string;
  /** The UI's origin, or "" for a message with no links. */
  uiBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Injected so a test does not wait. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_MS = 10_000;
const BACKOFF_MS = [500, 2_000];
/** Slack's limit on one text field is 3000 characters; stay well inside it. */
const MAX_FIELD = 300;
const MAX_REASON = 600;

const clip = (text: string, max: number): string => {
  const clean = redactPii(String(text)).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export interface SlackPayload {
  text: string;
  mrkdwn: false;
  blocks: unknown[];
}

const plain = (text: string) => ({ type: "plain_text", text, emoji: false });

/** The message for a cycle that needs a person. Pure: the same request gives the same payload. */
export function buildNeedsHumanMessage(req: NotifyRequest, uiBaseUrl: string): SlackPayload {
  const what = `${clip(req.functionName, MAX_FIELD)} (${clip(req.errorType, 60)})`;
  const headline =
    req.path === "notify"
      ? `Needs a human: ${what}. No code change helps.`
      : `Needs a human: ${what}. Starfish tried a fix and could not finish it.`;
  const blocks: unknown[] = [
    { type: "header", text: plain(req.path === "notify" ? "Needs a human" : "Needs a human: fix not finished") },
    { type: "section", text: plain(`${clip(req.functionName, MAX_FIELD)} failed${req.occurrenceCount === null ? "" : ` ${req.occurrenceCount} times`}.\n${clip(req.reason, MAX_REASON)}`) },
    {
      type: "section",
      fields: [
        plain(`Service: ${clip(req.service, 80)}`),
        plain(`Error type: ${clip(req.errorType, 60)}`),
        plain(`Why it stopped: ${clip(req.rule, 80)}`),
      ],
    },
  ];
  const links = [
    { label: "Open the incident", url: incidentUrl(uiBaseUrl, req.incidentId) },
    { label: "Watch the run", url: runUrl(uiBaseUrl, req.cycleId) },
    { label: "Open the issue", url: safeHttpsUrl(req.issueUrl) },
  ].filter((l): l is { label: string; url: string } => l.url !== null);
  if (links.length > 0) blocks.push({ type: "actions", elements: links.map((l) => ({ type: "button", text: plain(l.label), url: l.url })) });
  return { text: headline, mrkdwn: false, blocks };
}

type Attempt = { kind: "ok" } | { kind: "retry"; reason: string; waitMs?: number } | { kind: "terminal"; reason: string };

/** Slack's own short error code when the body is one (`invalid_token`); never any other body text. */
function slackCode(body: string): string {
  const t = body.trim();
  return /^[a-z][a-z_]{2,40}$/.test(t) ? t : "";
}

async function postOnce(deps: SlackDeps, payload: SlackPayload): Promise<Attempt> {
  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(deps.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    // The error text can contain the URL: say only what kind of failure it was.
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { kind: "retry", reason: timedOut ? "timeout" : "network-error" };
  }
  let body = "";
  try {
    body = (await res.text()).slice(0, 200);
  } catch {
    // an unreadable body does not change what the status said
  }
  if (res.ok) return body.trim() === "ok" || body.trim() === "" ? { kind: "ok" } : { kind: "terminal", reason: "unexpected-response" };
  const code = slackCode(body);
  const reason = `http-${res.status}${code ? `:${code}` : ""}`;
  if (res.status === 429) {
    const secs = Number(res.headers.get("retry-after"));
    return { kind: "retry", reason, ...(Number.isFinite(secs) && secs > 0 && { waitMs: Math.min(secs * 1000, MAX_RETRY_WAIT_MS) }) };
  }
  if (res.status >= 500) return { kind: "retry", reason };
  return { kind: "terminal", reason };
}

/** Post the message with bounded retries. Never throws; never returns the webhook. */
export async function deliverToSlack(deps: SlackDeps, payload: SlackPayload): Promise<DeliveryResult> {
  const max = Math.max(1, deps.maxAttempts ?? MAX_ATTEMPTS);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "unknown";
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await postOnce(deps, payload);
    if (result.kind === "ok") return { state: "sent", attempts: attempt };
    last = result.reason;
    if (result.kind === "terminal") return { state: "failed", attempts: attempt, reason: last };
    if (attempt < max) await sleep(result.waitMs ?? BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!);
  }
  return { state: "failed", attempts: max, reason: `${last} (gave up after ${max} attempts)` };
}

/** The notifier the loop calls. */
export function createSlackNotifier(deps: SlackDeps): (req: NotifyRequest) => Promise<DeliveryResult> {
  return (req) => deliverToSlack(deps, buildNeedsHumanMessage(req, deps.uiBaseUrl));
}
