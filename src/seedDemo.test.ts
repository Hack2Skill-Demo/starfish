import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { sanitizeEvent } from "./agent/cycle.js";
import { buildDemoPlan, DEMO_ENVIRONMENT, describePlan, SYNTHETIC_ID_PREFIX, SYNTHETIC_MESSAGE_PREFIX } from "./seedDemo.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const plan = buildDemoPlan(NOW);
const millis = (v: unknown) => (v as Timestamp).toMillis();

describe("buildDemoPlan", () => {
  it("is deterministic for a given now: fixed ids, so a re-run replaces instead of duplicating", () => {
    expect(buildDemoPlan(NOW)).toEqual(plan);
    const later = buildDemoPlan(new Date(NOW.getTime() + 86_400_000));
    expect(later.incidents.map((d) => d.id)).toEqual(plan.incidents.map((d) => d.id));
    expect(later.cycles.map((d) => d.id)).toEqual(plan.cycles.map((d) => d.id));
  });

  it("covers every finished path the loop has", () => {
    expect(plan.cycles.map((c) => c.data.path).sort()).toEqual(["decline", "draft", "human", "notify", "pr"]);
    expect(Object.fromEntries(plan.cycles.map((c) => [c.data.path, [c.data.state, c.data.outcome]]))).toEqual({
      decline: ["declined", "model-decline"],
      notify: ["waiting-human", "notify:model-notify"],
      draft: ["waiting-human", "dry-run"],
      pr: ["done", "pr-opened"],
      human: ["waiting-human", "review-blocked"],
    });
  });

  it("marks every document synthetic, and says so in each incident's message and each cycle's first event", () => {
    for (const d of [...plan.incidents, ...plan.cycles, ...plan.cycles.flatMap((c) => c.events)]) {
      expect(d.data.synthetic).toBe(true);
      expect(d.data.environment).toBe(DEMO_ENVIRONMENT);
    }
    for (const inc of plan.incidents) {
      expect(inc.id.startsWith(SYNTHETIC_ID_PREFIX)).toBe(true);
      expect(String(inc.data.errorMessage).startsWith(SYNTHETIC_MESSAGE_PREFIX)).toBe(true);
      // Never a sha256, so it can never collide with a real incident's fingerprint.
      expect(inc.data.fingerprint).not.toMatch(/^[0-9a-f]{64}$/);
    }
    for (const c of plan.cycles) expect(String(c.events[0]?.data.summary)).toMatch(/synthetic/i);
  });

  it("links nowhere and names no model: no url in any record, no model in any triage record", () => {
    for (const c of plan.cycles) {
      const summary = c.data.summary as Record<string, Record<string, unknown>>;
      for (const record of Object.values(summary)) expect(Object.keys(record)).not.toContain("url");
      expect(String(summary.triage?.model)).toMatch(/no model was called/);
    }
  });

  it("gives every incident a settled cycle for recurrence 0, so the agent's pass never selects one", () => {
    expect(plan.cycles.map((c) => c.data.incidentId).sort()).toEqual(plan.incidents.map((d) => d.id).sort());
    for (const c of plan.cycles) {
      expect(c.id).toBe(`${String(c.data.incidentId)}_r0`);
      expect(c.data.state).not.toBe("running");
      expect(c.data.leaseExpiresAt).toBeNull();
    }
  });

  it("writes events and run records in the shape cycle.ts leaves them", () => {
    for (const c of plan.cycles) {
      expect(c.data.eventCount).toBe(c.events.length);
      expect(c.events.map((e) => e.data.seq)).toEqual(c.events.map((_, i) => i + 1));
      expect(c.events.map((e) => e.id)).toEqual(c.events.map((_, i) => String(i + 1).padStart(6, "0")));
      const times = c.events.map((e) => millis(e.data.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(millis(c.data.createdAt)).toBe(times[0]);
      expect(millis(c.data.updatedAt)).toBe(times[times.length - 1]);
      expect(c.data.stage).toBe(c.events[c.events.length - 1]?.data.stage);
      // Already what sanitizeEvent would store: redacted, bounded, flat.
      for (const e of c.events) {
        const { stage, type, summary, data } = e.data as { stage: string; type: string; summary: string; data: Record<string, never> };
        expect(sanitizeEvent({ stage, type, summary, data })).toEqual({ stage, type, summary, data });
      }
      // summary.<stage> is a stage's LAST record, as recordEvent's dotted-path write leaves it.
      const summary = c.data.summary as Record<string, unknown>;
      for (const stage of Object.keys(summary)) expect(c.events.some((e) => e.data.stage === stage)).toBe(true);
    }
    const human = plan.cycles.find((c) => c.data.path === "human")!;
    expect((human.data.summary as Record<string, { verdict?: string; revisions?: number }>).review?.verdict).toBe("block");
    expect((human.data.summary as Record<string, { revisions?: number }>).fix?.revisions).toBe(1);
    const pr = plan.cycles.find((c) => c.data.path === "pr")!.data.summary as Record<string, { status?: string; revisions?: number }>;
    expect(pr.verify?.status).toBe("passed"); // the failed first verify was replaced by the passing one
    expect(pr.fix?.revisions).toBe(1);
  });

  it("records one patch hash across verify, review and pull request on each passing path", () => {
    for (const c of plan.cycles) {
      const s = c.data.summary as Record<string, { patchSha256?: string }>;
      const hashes = [s.verify, s.review, s.pr].flatMap((r) => (r?.patchSha256 ? [r.patchSha256] : []));
      expect(new Set(hashes).size).toBeLessThanOrEqual(1);
    }
  });

  it("places incidents and cycles in the recent past, never the future", () => {
    for (const inc of plan.incidents) {
      expect(millis(inc.data.firstOccurredAt)).toBeLessThanOrEqual(millis(inc.data.lastOccurredAt));
      expect(millis(inc.data.lastOccurredAt)).toBeLessThan(NOW.getTime());
      const buckets = inc.data.occurrencesByHour as Record<string, number>;
      expect(Object.values(buckets).reduce((a, b) => a + b, 0)).toBe(inc.data.occurrenceCount);
    }
    for (const c of plan.cycles) {
      for (const e of c.events) expect(millis(e.data.at)).toBeLessThan(NOW.getTime());
      expect(millis(c.data.createdAt)).toBeGreaterThan(NOW.getTime() - 5 * 86_400_000);
    }
  });

  it("describes one line per document for the dry run", () => {
    const lines = describePlan(plan, { incidentCollection: "incidents", cycleCollection: "starfish_cycles" });
    expect(lines).toHaveLength(plan.incidents.length + plan.cycles.length);
    expect(lines.some((l) => l.startsWith(`starfish_cycles/${SYNTHETIC_ID_PREFIX}pr_r0`))).toBe(true);
  });
});
