/**
 * The agent pass's start mark against the real Firestore emulator: an update keeps the previous pass's record and adds
 * `runningSince`, a first pass creates the document, and the end-of-pass write drops the mark. The update-or-create
 * path hangs on the Admin SDK's NOT_FOUND code, which a fake would only assume. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { parseAgentPassInProgress, parseAgentRunRecord } from "../agentRunRecord.js";
import { AGENT_LAST_RUN_DOC, newAgentPassReport, recordAgentLastRun, recordAgentPassStarted } from "./lastRun.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("agent/lastRun.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "agent-last-run-emulator-tests");
const db: Firestore = getFirestore(app, "agent-last-run-tests");
afterAll(() => deleteApp(app));

const EARLIER = new Date("2026-10-10T15:30:00.000Z");
const EARLIER_END = new Date("2026-10-10T15:31:00.000Z");
const NOW = new Date("2026-10-10T16:30:00.000Z");

let runCollection: string;
beforeEach(() => {
  runCollection = `runs_${randomUUID().slice(0, 8)}`;
});
const read = async () => (await db.collection(runCollection).doc(AGENT_LAST_RUN_DOC).get()).data();

describe("recordAgentPassStarted (the start mark)", () => {
  it("adds the mark to the previous pass's record and keeps that record readable", async () => {
    const previous = { ...newAgentPassReport(EARLIER, "demo"), dryRun: false };
    expect(await recordAgentLastRun(db, { runCollection }, previous, EARLIER_END)).toBe(true);

    expect(await recordAgentPassStarted(db, { runCollection }, "demo", NOW)).toBe(true);

    const data = await read();
    expect(parseAgentPassInProgress(data)).toEqual({ environment: "demo", since: NOW });
    expect(parseAgentRunRecord(data)).toMatchObject({ environment: "demo", outcome: "ok", finishedAt: EARLIER_END });
  });

  it("creates the record on a first pass, holding the environment the guests' rule reads", async () => {
    expect(await recordAgentPassStarted(db, { runCollection }, "demo", NOW)).toBe(true);

    const data = await read();
    expect(data?.environment).toBe("demo");
    expect(parseAgentPassInProgress(data)).toEqual({ environment: "demo", since: NOW });
    expect(parseAgentRunRecord(data)).toBeNull();
  });

  it("is dropped by the end-of-pass write", async () => {
    await recordAgentPassStarted(db, { runCollection }, "demo", NOW);
    expect(await recordAgentLastRun(db, { runCollection }, newAgentPassReport(NOW, "demo"), new Date(NOW.getTime() + 60_000))).toBe(true);

    const data = await read();
    expect(data?.runningSince).toBeUndefined();
    expect(parseAgentPassInProgress(data)).toBeNull();
  });
});
