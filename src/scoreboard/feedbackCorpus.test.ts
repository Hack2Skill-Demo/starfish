import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { buildFeedbackCorpus, caseIdFor } from "./feedbackCorpus.js";
import { loadCorpus, readIncident } from "./corpus.js";

const doc = (level: string, over: Record<string, unknown> = {}) => ({
  environment: "demo",
  functionName: "mailDrainer",
  service: "mail",
  errorType: "TimeoutError",
  errorMessage: "send failed",
  occurrenceCount: 4,
  correctedLevel: level,
  correctedBy: "op1",
  correctedAt: Timestamp.fromMillis(0),
  correctionNote: "PRIVATE NOTE",
  ...over,
});
const triage = { counterCount: 7, counterWindow: "24h" };
const opts = { corpusVersion: "feedback-demo-test", appRevision: "abc123" };

describe("buildFeedbackCorpus", () => {
  it("turns noise and log corrections into decline and notify cases that the corpus loader accepts", () => {
    const corpus = buildFeedbackCorpus(
      [
        { id: "i1", doc: doc("noise"), triage },
        { id: "i2", doc: doc("log"), triage: { ...triage, counterCapped: true } },
      ],
      opts
    );
    expect(corpus.skipped).toEqual([]);
    expect(corpus.manifest).toMatchObject({ corpusVersion: "feedback-demo-test", appRevision: "abc123", synthetic: false });
    expect(corpus.manifest.cases).toEqual([
      { caseId: "fb-i1", split: "tuning", path: "decline", expectedTriage: "decline", incident: "cases/fb-i1/incident.json" },
      { caseId: "fb-i2", split: "tuning", path: "notify", expectedTriage: "notify", incident: "cases/fb-i2/incident.json" },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "feedback-corpus-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(corpus.manifest));
    for (const [rel, content] of Object.entries(corpus.files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const loaded = loadCorpus(dir);
    expect(loaded.cases.map((c) => [c.caseId, c.path, c.expectedTriage])).toEqual([
      ["fb-i1", "decline", "decline"],
      ["fb-i2", "notify", "notify"],
    ]);
    expect(readIncident(loaded.cases[1]!)).toMatchObject({ id: "i2", functionName: "mailDrainer", message: "send failed", logCounterCheck: { window: "24h", count: 7, capped: true } });
  });

  it("never writes the correction's note or who made it", () => {
    const corpus = buildFeedbackCorpus([{ id: "i1", doc: doc("noise"), triage }], opts);
    const all = Object.values(corpus.files).join("\n") + JSON.stringify(corpus.manifest);
    expect(all).not.toContain("PRIVATE NOTE");
    expect(all).not.toContain("op1");
  });

  it("skips, with why, a correction a triage-only case can't express and an incident with no recorded counter-check", () => {
    const corpus = buildFeedbackCorpus(
      [
        { id: "a", doc: doc("fix"), triage },
        { id: "b", doc: doc("merge"), triage },
        { id: "c", doc: doc("log") },
        { id: "d", doc: doc("log"), triage: { counterCount: null, counterWindow: "24h" } },
        { id: "e", doc: { environment: "demo" }, triage },
      ],
      opts
    );
    expect(corpus.manifest.cases).toEqual([]);
    expect(corpus.skipped.map((s) => [s.incidentId, s.reason.split(":")[0]])).toEqual([
      ["a", "corrected to fix"],
      ["b", "corrected to merge"],
      ["c", "no counter-check recorded"],
      ["d", "no counter-check recorded"],
      ["e", "no correction"],
    ]);
  });

  it("makes a case id the corpus path guard accepts, unique per incident id", () => {
    expect(caseIdFor("abc_1")).toBe("fb-abc_1");
    const a = caseIdFor("a b");
    const b = caseIdFor("a/b");
    expect(a).toMatch(/^fb-a-b-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});
