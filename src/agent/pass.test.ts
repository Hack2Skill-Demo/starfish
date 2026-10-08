import { describe, expect, it, vi } from "vitest";
import { MAX_CONSECUTIVE_ERRORS, pathsFromStack, runAgentPass, type Candidate, type PassDeps } from "./pass.js";
import type { LoopResult } from "./loop.js";

const REPO = [
  "src/orders/create.ts",
  "src/orders/helpers.ts",
  "src/billing/create.ts",
  "src/index.ts",
  "lib/vendor/thing.js",
  "node_modules/dep/index.js",
  ".github/workflows/ci.yml",
  "package.json",
  "tests/orders.test.ts",
];

describe("pathsFromStack", () => {
  it("maps frames to repository files, top frame first, without repeats", () => {
    const stack = [
      "TypeError: x is undefined",
      "    at createOrder (/workspace/src/orders/create.ts:42:7)",
      "    at helper (/workspace/src/orders/helpers.ts:10:3)",
      "    at again (/workspace/src/orders/create.ts:50:1)",
    ].join("\n");
    expect(pathsFromStack(stack, REPO, [])).toEqual(["src/orders/create.ts", "src/orders/helpers.ts"]);
  });

  it("prefers the longest repository path a frame ends with", () => {
    expect(pathsFromStack("at f (/app/src/billing/create.ts:1:1)", REPO, [])).toEqual(["src/billing/create.ts"]);
    expect(pathsFromStack("at f (/app/src/orders/create.ts:1:1)", REPO, [])).toEqual(["src/orders/create.ts"]);
  });

  it("finds the .ts source of a compiled .js frame, and a unique match once a leading directory is dropped", () => {
    expect(pathsFromStack("at f (/workspace/src/orders/create.js:3:9)", REPO, [])).toEqual(["src/orders/create.ts"]);
    expect(pathsFromStack("at f (/workspace/lib/orders/helpers.js:3:9)", REPO, [])).toEqual(["src/orders/helpers.ts"]);
  });

  it("finds a package's source from a compiled frame whose build directory replaced it (Cloud Functions)", () => {
    const repo = ["functions/src/orders/createOrder.ts", "functions/src/orders/listRecentOrders.ts", "functions/src/index.ts", "web/src/App.tsx"];
    expect(pathsFromStack("at createOrder (/workspace/lib/orders/createOrder.js:42:11)", repo, [])).toEqual(["functions/src/orders/createOrder.ts"]);
    // The same with source maps on: the frame already names a .ts under src/.
    expect(pathsFromStack("at createOrder (/workspace/src/orders/createOrder.ts:42:11)", repo, [])).toEqual(["functions/src/orders/createOrder.ts"]);
    // A directory alone is not enough: orders/ appears in several files, the file name must match too.
    expect(pathsFromStack("at x (/workspace/lib/orders/other.js:1:1)", repo, [])).toEqual([]);
  });

  it("does not guess between two packages that both hold the same tail, nor from a bare file name", () => {
    const repo = ["functions/src/orders/createOrder.ts", "admin/src/orders/createOrder.ts", "functions/src/index.ts"];
    expect(pathsFromStack("at f (/workspace/lib/orders/createOrder.js:1:1)", repo, [])).toEqual([]);
    expect(pathsFromStack("at f (/workspace/lib/index.js:1:1)", repo, [])).toEqual([]);
  });

  it("prefers the longest of two repository paths one of which ends the other", () => {
    expect(pathsFromStack("at f (/app/src/index.ts:1:1)", ["index.ts", "src/index.ts"], [])).toEqual(["src/index.ts"]);
  });

  it("does not guess when the loose match is ambiguous, or when only a bare file name would match", () => {
    // Two roots hold orders/create.ts: a compiled frame under lib/ must not pick one.
    expect(pathsFromStack("at f (/workspace/lib/orders/create.js:3:9)", ["src/orders/create.ts", "app/orders/create.ts"], [])).toEqual([]);
    // A single file name is not enough to call it the same file.
    expect(pathsFromStack("at f (/app/lib/index.js:1:1)", REPO, [])).toEqual([]);
  });

  it("never chooses node_modules, an excluded path, or a file that is not in the repository", () => {
    const stack = [
      "at a (/app/node_modules/dep/index.js:1:1)",
      "at b (/app/.github/workflows/ci.yml:1:1)",
      "at c (/etc/passwd:1:1)",
      "at d (/app/../../etc/shadow.js:1:1)",
      "at e (node:internal/process:1:1)",
      "at f (/app/src/index.ts:1:1)",
    ].join("\n");
    expect(pathsFromStack(stack, REPO, [".github/"])).toEqual(["src/index.ts"]);
    // An excluded path is also refused even when the frame names it.
    expect(pathsFromStack("at g (/app/tests/orders.test.ts:1:1)", REPO, ["tests/"])).toEqual([]);
  });

  it("keeps node_modules out at both ends: a frame in it, and a repository file in it", () => {
    // The frame is inside node_modules and a source file elsewhere shares its tail: still not chosen.
    expect(pathsFromStack("at f (/app/node_modules/dep/index.js:1:1)", ["src/dep/index.js"], [])).toEqual([]);
    // The frame is fine but the only file that fits lives in node_modules: not chosen either.
    expect(pathsFromStack("at f (/app/vendor/dep.js:1:1)", ["node_modules/vendor/dep.js"], [])).toEqual([]);
  });

  it("reads only the start of a very long stack", () => {
    expect(pathsFromStack("x".repeat(20_000) + "\nat f (/app/src/index.ts:1:1)", REPO, [])).toEqual([]);
  });

  it("handles Windows paths, file URLs and traces with no frames", () => {
    expect(pathsFromStack("at f (C:\\app\\src\\index.ts:1:1)", REPO, [])).toEqual(["src/index.ts"]);
    expect(pathsFromStack("at f (file:///app/src/index.ts:1:1)", REPO, [])).toEqual(["src/index.ts"]);
    expect(pathsFromStack("Error: boom", REPO, [])).toEqual([]);
    expect(pathsFromStack(undefined, REPO, [])).toEqual([]);
    expect(pathsFromStack("", REPO, [])).toEqual([]);
  });

  it("stops at the cap", () => {
    const stack = ["src/orders/create.ts", "src/orders/helpers.ts", "src/index.ts"].map((p) => `at f (/app/${p}:1:1)`).join("\n");
    expect(pathsFromStack(stack, REPO, [], 2)).toEqual(["src/orders/create.ts", "src/orders/helpers.ts"]);
    expect(pathsFromStack(stack, REPO, [], 0)).toEqual([]);
  });

  it("is not slowed by a huge stack", () => {
    const stack = "at f (/app/src/index.ts:1:1)\n".repeat(200_000);
    const t = Date.now();
    expect(pathsFromStack(stack, REPO, [])).toEqual(["src/index.ts"]);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("runAgentPass", () => {
  const finished: LoopResult = { kind: "finished", state: "waiting-human", outcome: "dry-run" };
  const cands = (n: number): Candidate[] => Array.from({ length: n }, (_, i) => ({ incidentId: `inc${i}`, recurrence: 0 }));
  const deps = (over: Partial<PassDeps> = {}): PassDeps => ({
    select: async (limit) => cands(limit),
    run: async () => finished,
    maxCycles: 3,
    describeError: (e) => (e instanceof Error ? e.message : String(e)),
    ...over,
  });

  it("runs one cycle per candidate, one at a time, up to the cap", async () => {
    let active = 0;
    let peak = 0;
    const run = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
      return finished;
    });
    const s = await runAgentPass(deps({ run, select: async () => cands(10), maxCycles: 4 }));
    expect(run).toHaveBeenCalledTimes(4);
    expect(peak).toBe(1);
    expect(s).toMatchObject({ considered: 10, ran: 4, aborted: false, errors: [] });
    expect(s.results.map((r) => r.incidentId)).toEqual(["inc0", "inc1", "inc2", "inc3"]);
  });

  it("sweeps stranded cycles once per pass, after the kill switch and even at the daily cap; a failed sweep is reported, not fatal (#226)", async () => {
    const sweep = vi.fn(async () => [{ incidentId: "old", reason: "retries-exhausted" }]);
    expect(await runAgentPass(deps({ sweep, automationEnabled: async () => false }))).toMatchObject({ skipped: "automation-disabled" });
    expect(sweep).not.toHaveBeenCalled();
    const capped = await runAgentPass(deps({ sweep, daily: { cap: 3, startedToday: async () => 3 } }));
    expect(capped).toMatchObject({ skipped: "daily-cap", gaveUp: [{ incidentId: "old", reason: "retries-exhausted" }] });
    const ran = await runAgentPass(deps({ sweep }));
    expect(ran).toMatchObject({ ran: 3, gaveUp: [{ incidentId: "old", reason: "retries-exhausted" }] });
    expect(sweep).toHaveBeenCalledTimes(2);
    const failing = await runAgentPass(deps({ sweep: () => Promise.reject(new Error("store down")) }));
    expect(failing).toMatchObject({ ran: 3, sweepError: "store down" });
    expect(failing.gaveUp).toBeUndefined();
  });

  it("starts no cycle, and selects nothing, while automation is off (#133)", async () => {
    const select = vi.fn(async (limit: number) => cands(limit));
    const run = vi.fn(async () => finished);
    const s = await runAgentPass(deps({ select, run, automationEnabled: async () => false }));
    expect(s).toEqual({ considered: 0, ran: 0, results: [], errors: [], aborted: false, skipped: "automation-disabled" });
    expect(select).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    const on = await runAgentPass(deps({ select, run, automationEnabled: async () => true }));
    expect(on.skipped).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("stops at the daily cap: selects only what is left of it, and records where the day stood (#5)", async () => {
    const select = vi.fn(async (limit: number) => cands(limit));
    const run = vi.fn(async () => finished);
    const s = await runAgentPass(deps({ select, run, maxCycles: 3, daily: { cap: 30, startedToday: async () => 29 } }));
    expect(select).toHaveBeenCalledWith(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.daily).toEqual({ cap: 30, startedBefore: 29 });
    expect(s.skipped).toBeUndefined();
  });

  it("starts nothing, and selects nothing, once the daily cap is reached", async () => {
    const select = vi.fn(async (limit: number) => cands(limit));
    const run = vi.fn(async () => finished);
    for (const started of [30, 31]) {
      const s = await runAgentPass(deps({ select, run, daily: { cap: 30, startedToday: async () => started } }));
      expect(s).toEqual({ considered: 0, ran: 0, results: [], errors: [], aborted: false, skipped: "daily-cap", daily: { cap: 30, startedBefore: started } });
    }
    expect(select).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("asks the daily count only after the kill switch, and lets a failed count propagate rather than run uncapped", async () => {
    const startedToday = vi.fn(async () => 0);
    await runAgentPass(deps({ automationEnabled: async () => false, daily: { cap: 30, startedToday } }));
    expect(startedToday).not.toHaveBeenCalled();
    const run = vi.fn(async () => finished);
    await expect(runAgentPass(deps({ run, daily: { cap: 30, startedToday: () => Promise.reject(new Error("no store")) } }))).rejects.toThrow("no store");
    expect(run).not.toHaveBeenCalled();
  });

  it("asks for no more than it may run", async () => {
    const select = vi.fn(async (limit: number) => cands(limit));
    await runAgentPass(deps({ select, maxCycles: 2 }));
    expect(select).toHaveBeenCalledWith(2);
  });

  it("records a refusal as a result, not an error", async () => {
    const s = await runAgentPass(deps({ run: async () => ({ kind: "not-acquired", reason: "held" }) }));
    expect(s.errors).toEqual([]);
    expect(s.results[0]!.result).toEqual({ kind: "not-acquired", reason: "held" });
  });

  it("keeps going after one cycle throws, and describes the error through the redactor it was given", async () => {
    const run = vi.fn(async (c: Candidate) => {
      if (c.incidentId === "inc0") throw new Error("store unreachable");
      return finished;
    });
    const s = await runAgentPass(deps({ run, describeError: (e) => `redacted:${(e as Error).message}` }));
    expect(s.errors).toEqual([{ incidentId: "inc0", message: "redacted:store unreachable" }]);
    expect(s.ran).toBe(3);
    expect(s.aborted).toBe(false);
  });

  it(`stops after ${MAX_CONSECUTIVE_ERRORS} cycles in a row throw, rather than burning every lease`, async () => {
    const run = vi.fn(async () => {
      throw new Error("down");
    });
    const s = await runAgentPass(deps({ run, select: async () => cands(10), maxCycles: 10 }));
    expect(run).toHaveBeenCalledTimes(MAX_CONSECUTIVE_ERRORS);
    expect(s).toMatchObject({ aborted: true, ran: MAX_CONSECUTIVE_ERRORS });
  });

  it("a success resets the streak", async () => {
    let n = 0;
    const run = vi.fn(async () => {
      n += 1;
      if (n % 3 !== 0) throw new Error("flaky");
      return finished;
    });
    const s = await runAgentPass(deps({ run, select: async () => cands(9), maxCycles: 9 }));
    expect(s.aborted).toBe(false);
    expect(run).toHaveBeenCalledTimes(9);
  });

  it("lets a failure to select propagate: with no candidates there is nothing to report", async () => {
    await expect(runAgentPass(deps({ select: async () => Promise.reject(new Error("no store")) }))).rejects.toThrow("no store");
  });

  it("does nothing, and says so, when there is nothing to do", async () => {
    const run = vi.fn();
    const s = await runAgentPass(deps({ select: async () => [], run }));
    expect(run).not.toHaveBeenCalled();
    expect(s).toEqual({ considered: 0, ran: 0, results: [], errors: [], aborted: false });
  });
});
