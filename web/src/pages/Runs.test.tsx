import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCycle, parseEvent, type CycleRow, type EventRow } from "../lib/runsModel";

type CyclesCb = (rows: CycleRow[], capped: boolean) => void;
type EventsCb = (rows: EventRow[], capped: boolean) => void;

const mocks = vi.hoisted(() => ({
  env: { environment: "demo", ready: true, settingsUnavailable: false },
  cyclesCb: undefined as undefined | ((rows: unknown[], capped: boolean) => void),
  cyclesErr: undefined as undefined | ((e: Error) => void),
  eventsCb: undefined as undefined | ((rows: unknown[], capped?: boolean) => void),
  eventsErr: undefined as undefined | ((e: Error) => void),
  unsubCycles: vi.fn(),
  unsubEvents: vi.fn(),
  subscribedEvents: [] as string[],
  cycleLimits: [] as number[],
  readCycle: vi.fn(),
  getIncident: vi.fn(),
}));

vi.mock("../lib/useSettings", () => ({ useEnvironment: () => mocks.env }));
vi.mock("../lib/incidents", () => ({ getIncident: mocks.getIncident }));
vi.mock("../components/EngineStatus", () => ({ EngineStatus: ({ environment }: { environment: string }) => <div data-testid="engine">{environment}</div> }));
// The button decides for itself who sees it (AdminActions.test.tsx); here only that the page offers it.
vi.mock("../components/AdminActions", () => ({ RunAgentButton: () => <button type="button">Run agent now</button> }));
vi.mock("../components/RetryRunButton", () => ({ RetryRunButton: ({ incidentId }: { incidentId: string }) => <button type="button">Retry with agent ({incidentId})</button> }));
// The card's own behaviour is HandoffCard.test.tsx; here only when the page shows it, and that the retry moves into it.
vi.mock("../components/HandoffCard", () => ({
  HandoffCard: ({ incidentId, path, canRetry }: { incidentId: string; path: string; canRetry: boolean }) => (
    <section aria-label="What you can do now" data-path={path}>
      {canRetry && <button type="button">Retry with agent ({incidentId})</button>}
    </section>
  ),
}));
vi.mock("../components/AgentStatus", () => ({ AgentStatus: ({ environment }: { environment: string }) => <div data-testid="agent">{environment}</div> }));
vi.mock("../lib/runs", async (orig) => ({
  ...(await orig<typeof import("../lib/runs")>()),
  subscribeCycles: (_env: string, ok: CyclesCb, err: (e: Error) => void, max: number) => {
    mocks.cycleLimits.push(max);
    mocks.cyclesCb = ok as never;
    mocks.cyclesErr = err;
    return mocks.unsubCycles;
  },
  readCycle: mocks.readCycle,
  subscribeEvents: (id: string, _env: string, ok: EventsCb, err: (e: Error) => void) => {
    mocks.subscribedEvents.push(id);
    mocks.eventsCb = ok as never;
    mocks.eventsErr = err;
    return mocks.unsubEvents;
  },
}));

import Runs from "./Runs";
import { CYCLE_LIMIT, EVENT_LIMIT } from "../lib/runs";
import { LIVE_RETRY_MS } from "../lib/useLiveRecord";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const now = Date.now();

function cycle(id: string, over: Record<string, unknown> = {}): CycleRow {
  return parseCycle(id, {
    incidentId: id.replace(/_r\d+$/, ""),
    environment: "demo",
    recurrence: 0,
    state: "running",
    attempts: 1,
    eventCount: 0,
    createdAt: ts(now - 60_000),
    updatedAt: ts(now - 1000),
    leaseExpiresAt: ts(now + 60_000),
    deadlineAt: ts(now + 600_000),
    ...over,
  })!;
}
const event = (seq: number, stage: string, type: string, summary: string, agoMs: number): EventRow =>
  parseEvent(String(seq).padStart(6, "0"), { seq, stage, type, summary, at: ts(now - agoMs), data: {} })!;

function renderRuns(url = "/runs") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Runs />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Runs page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscribedEvents.length = 0;
    mocks.cycleLimits.length = 0;
    mocks.cyclesCb = mocks.cyclesErr = mocks.eventsCb = mocks.eventsErr = undefined;
    mocks.env = { environment: "demo", ready: true, settingsUnavailable: false };
    mocks.getIncident.mockResolvedValue(null);
    localStorage.removeItem("starfish.runs.listHidden");
    localStorage.removeItem("starfish.runs.replaySpeed");
  });

  it("says the settings couldn't be read, so an empty list isn't taken for a quiet day (#143)", () => {
    mocks.env = { environment: "build-label", ready: true, settingsUnavailable: true };
    renderRuns();
    act(() => mocks.cyclesCb!([], false));
    const notice = screen.getByText(/Couldn't read the runtime settings/);
    expect(notice).toHaveTextContent("runs are filtered");
    expect(notice).toHaveTextContent("build-label");
  });

  it("offers the agent's \"run now\" beside the heading (#276)", () => {
    renderRuns();
    expect(screen.getByRole("button", { name: "Run agent now" })).toBeInTheDocument();
  });

  it("shows no settings notice when the settings read succeeded", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([], false));
    expect(screen.queryByText(/Couldn't read the runtime settings/)).toBeNull();
  });

  it("says nothing has run, instead of looking like a quiet day", async () => {
    renderRuns();
    act(() => mocks.cyclesCb!([], false));
    expect(await screen.findByText("No runs recorded")).toBeInTheDocument();
  });

  it("says when the runs can't be read", () => {
    renderRuns();
    act(() => mocks.cyclesErr!(new Error("denied")));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the runs");
    expect(screen.getByRole("alert")).toHaveTextContent("Check that firestore.rules and firestore.indexes.json are deployed");
    expect(screen.getByRole("alert")).toHaveTextContent("may still be building");
  });

  it("listens again a while after the runs or a run's events fail, and says so until a new snapshot arrives (#357)", () => {
    vi.useFakeTimers();
    try {
      renderRuns();
      act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
      act(() => mocks.eventsCb!([event(1, "cycle", "started", "Attempt 1", 50_000)]));
      const detail = () => screen.getByRole("region", { name: "Run detail" });

      // A run's events: started again after LIVE_RETRY_MS, still failed until the new listener answers.
      act(() => mocks.eventsErr!(new Error("unavailable")));
      expect(within(detail()).getByRole("alert")).toHaveTextContent("Couldn't read this run's events.");
      act(() => vi.advanceTimersByTime(LIVE_RETRY_MS - 1));
      expect(mocks.subscribedEvents).toEqual(["inc-a_r0"]);
      act(() => vi.advanceTimersByTime(1));
      expect(mocks.subscribedEvents).toEqual(["inc-a_r0", "inc-a_r0"]);
      expect(mocks.unsubEvents).toHaveBeenCalledTimes(1);
      expect(within(detail()).getByRole("alert")).toHaveTextContent("Couldn't read this run's events.");
      act(() => mocks.eventsCb!([event(1, "cycle", "started", "Attempt 2", 50_000)]));
      expect(within(detail()).queryByRole("alert")).toBeNull();
      expect(within(detail()).getByText("Attempt 2")).toBeInTheDocument();

      // The list: the same, at the same page size, never the old rows in between (#195).
      act(() => mocks.cyclesErr!(new Error("unavailable")));
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the runs");
      expect(mocks.cycleLimits).toEqual([CYCLE_LIMIT]);
      act(() => vi.advanceTimersByTime(LIVE_RETRY_MS));
      expect(mocks.cycleLimits).toEqual([CYCLE_LIMIT, CYCLE_LIMIT]);
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read the runs");
      expect(screen.queryByRole("region", { name: "Run detail" })).toBeNull();
      act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
      expect(screen.queryByText(/Couldn't read the runs/)).toBeNull();
      expect(detail()).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists runs, opens the newest, and draws a partial run's missing steps as not reached", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "declined", leaseExpiresAt: null, path: "decline", outcome: "declined", summary: { triage: { rule: "no-repro" } } }), cycle("inc-b_r1")], false));

    expect(mocks.subscribedEvents).toEqual(["inc-a_r0"]);
    act(() => mocks.eventsCb!([event(1, "cycle", "started", "Attempt 1", 50_000), event(2, "triage", "decision", "Decided not to act", 40_000)]));

    const detail = screen.getByRole("region", { name: "Run detail" });
    expect(within(detail).getByText("Declined: no fix attempted")).toBeInTheDocument();
    expect(within(detail).getByText("no-repro")).toBeInTheDocument();
    const steps = within(detail).getByRole("list", { name: "Steps" });
    const status = (stage: string) => steps.querySelector(`[data-step="${stage}"]`)?.getAttribute("data-status");
    expect(status("triage")).toBe("done");
    for (const stage of ["fix", "verify", "review", "pr"]) expect(status(stage)).toBe("not-reached");
    expect(within(detail).getByText("Attempt 1")).toBeInTheDocument();
    expect(within(detail).getByText("1 of 5 steps recorded")).toBeInTheDocument();
    // The agent's health sits in the page header, for the environment shown; not the ingest's (#274).
    expect(screen.getByTestId("agent")).toHaveTextContent("demo");
    expect(screen.queryByTestId("engine")).toBeNull();
  });

  it("labels a run with its incident function and error, keeping the ID as a fallback", async () => {
    mocks.getIncident.mockImplementation(async (id: string) =>
      id === "inc-a" ? { id, functionName: "control-getscenarios", errorType: "UnknownError", errorMessage: "getScenarios failed" } : null
    );
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0"), cycle("inc-b_r0")], false));
    const list = screen.getByRole("region", { name: "Runs" });
    expect(await within(list).findByText("control-getscenarios")).toBeInTheDocument();
    expect(within(list).getByText("UnknownError")).toBeInTheDocument();
    expect(within(list).getByText(/· getScenarios failed/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "control-getscenarios" })).toBeInTheDocument();
    expect(within(list).getByText("inc-b")).toBeInTheDocument();
    expect(mocks.getIncident).toHaveBeenCalledWith("inc-a", "demo");
  });

  it("badges a synthetic run in the list and its header, and only that run", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("synthetic-demo-pr_r0", { synthetic: true, state: "done", leaseExpiresAt: null }), cycle("inc-b_r0")], false));
    const list = screen.getByRole("region", { name: "Runs" });
    expect(within(list).getAllByText("Synthetic")).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "Run detail" })).getByText("Synthetic")).toBeInTheDocument();
  });

  it("marks a run in progress only while a worker holds it", () => {
    renderRuns();
    act(() =>
      mocks.cyclesCb!([cycle("inc-a_r0"), cycle("inc-b_r0", { leaseExpiresAt: ts(now - 1000) })], false)
    );
    const list = screen.getByRole("region", { name: "Runs" });
    expect(within(list).getAllByText("In progress")).toHaveLength(1);
    expect(within(list).getByText("Waiting for a worker")).toBeInTheDocument();
  });

  it("switches to the run you pick, and follows the link in the URL", async () => {
    const view = renderRuns("/runs?run=inc-b_r0");
    act(() => mocks.cyclesCb!([cycle("inc-a_r0"), cycle("inc-b_r0")], false));
    expect(mocks.subscribedEvents).toEqual(["inc-b_r0"]);
    expect(screen.getByRole("heading", { name: "inc-b" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /inc-a/ }));
    expect(mocks.subscribedEvents.at(-1)).toBe("inc-a_r0");
    expect(mocks.unsubEvents).toHaveBeenCalled();
    view.unmount();
    expect(mocks.unsubCycles).toHaveBeenCalled();
  });

  it("links a pull request only when its URL is https", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, summary: { pr: { url: "https://github.com/o/r/pull/9", number: 9 } } })], false));
    expect(screen.getByRole("link", { name: /Pull request #9/ })).toHaveAttribute("href", "https://github.com/o/r/pull/9");
  });

  it("narrows the list to runs that ended a given way, says so, and ignores an unknown value", () => {
    const two = [cycle("inc-a_r0", { state: "declined", leaseExpiresAt: null, path: "decline" }), cycle("inc-b_r0", { state: "waiting-human", leaseExpiresAt: null, path: "pr" })];
    const first = renderRuns("/runs?path=pr");
    act(() => mocks.cyclesCb!(two, false));
    expect(screen.getByTestId("path-filter")).toHaveTextContent("Pull request opened");
    const list = screen.getByRole("region", { name: "Runs" });
    expect(within(list).getByText("inc-b")).toBeInTheDocument();
    expect(within(list).queryByText("inc-a")).toBeNull();
    first.unmount();

    renderRuns("/runs?path=bogus");
    act(() => mocks.cyclesCb!(two, false));
    expect(screen.queryByTestId("path-filter")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Runs" })).getByText("inc-a")).toBeInTheDocument();
  });

  it("narrows to missing-index heals that held, and to runs waiting on a human", () => {
    const rows = [
      cycle("inc-a_r0", { state: "done", leaseExpiresAt: null, path: "index", summary: { index: { runtime: "healed" } } }),
      cycle("inc-b_r0", { state: "done", leaseExpiresAt: null, path: "index", summary: { index: { runtime: "observing" } } }),
      cycle("inc-c_r0", { state: "waiting-human", leaseExpiresAt: null, path: "pr" }),
    ];
    const first = renderRuns("/runs?heal=healed");
    act(() => mocks.cyclesCb!(rows, false));
    expect(screen.getByTestId("path-filter")).toHaveTextContent("Missing-index heals that held through their window · 1");
    let list = screen.getByRole("region", { name: "Runs" });
    expect(within(list).getByText("inc-a")).toBeInTheDocument();
    expect(within(list).queryByText("inc-b")).toBeNull();
    first.unmount();

    renderRuns("/runs?state=waiting-human");
    act(() => mocks.cyclesCb!(rows, false));
    list = screen.getByRole("region", { name: "Runs" });
    expect(within(list).getByText("inc-c")).toBeInTheDocument();
    expect(within(list).queryByText("inc-a")).toBeNull();
  });

  it("says when no run ended the chosen way", () => {
    renderRuns("/runs?path=failed");
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { path: "pr" })], false));
    expect(screen.getByText("No recorded run matches this filter.")).toBeInTheDocument();
  });

  it("keeps the filter when you pick a run", async () => {
    renderRuns("/runs?path=pr");
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { path: "pr" }), cycle("inc-b_r0", { path: "pr" })], false));
    await userEvent.click(screen.getByRole("button", { name: /inc-b/ }));
    expect(screen.getByTestId("path-filter")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "inc-b" })).toBeInTheDocument();
  });

  it("links a run to its incident's evidence page", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
    expect(screen.getByRole("link", { name: "Evidence for this incident" })).toHaveAttribute("href", "/incidents/inc-a");
  });

  it("links the pull request from its own step too, but only once that step happened", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, summary: { pr: { url: "https://github.com/o/r/pull/9", number: 9 } } })], false));
    act(() => mocks.eventsCb!([]));
    expect(screen.queryByRole("link", { name: /GitHub pull request/ })).toBeNull();
    act(() => mocks.eventsCb!([event(1, "pr", "opened", "Opened a pull request", 1000)]));
    const ref = screen.getByRole("link", { name: "GitHub pull request o/r#9" });
    expect(ref).toHaveAttribute("href", "https://github.com/o/r/pull/9");
    expect(ref).toHaveTextContent("o/r#9");
  });

  it("puts the step log under the pipeline, newest first, with the step in progress on top (#279)", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { stage: "fix", summary: { triage: { decision: "act", rule: "model-act", reason: "A null guard is missing." } } })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "A null guard is missing.", 30_000)]));
    const log = screen.getByRole("list", { name: "Step log" });
    const entries = within(log).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("Draft a fix");
    expect(entries[0]).toHaveTextContent("In progress");
    expect(entries[1]).toHaveTextContent("Triage");
    expect(entries[1]).toHaveTextContent("A null guard is missing.");
    // Under the track and above the facts: it is read while the track moves.
    const pipeline = screen.getByRole("region", { name: "Pipeline" });
    expect(pipeline).toContainElement(log);
    expect(log.compareDocumentPosition(screen.getByRole("region", { name: "Run facts" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows triage's suspected cause and whose words they are in its own entry, and the issue's link in the issue's", () => {
    renderRuns();
    const summary = {
      triage: { decision: "notify", rule: "model-notify", reason: "The account lacks a role.", suspectedCause: "IAM on the function's account", model: "gemini-x" },
      issue: { state: "opened", number: 30, url: "https://github.com/o/r/issues/30" },
    };
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", path: "notify", leaseExpiresAt: null, summary })], false));
    expect(screen.getByRole("link", { name: /Issue #30/ })).toHaveAttribute("href", "https://github.com/o/r/issues/30");
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "The account lacks a role.", 9000)]));
    const log = screen.getByRole("list", { name: "Step log" });
    expect(within(log).getByText(/Suspected cause:/).parentElement).toHaveTextContent("IAM on the function's account");
    expect(within(log).getByText(/The model's reasoning/)).toHaveTextContent("gemini-x");
    expect(within(log).queryByRole("link", { name: /GitHub issue/ })).toBeNull();
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "The account lacks a role.", 9000), event(2, "issue", "opened", "Issue #30 filed", 8000)]));
    const ref = within(log).getByRole("link", { name: "GitHub issue o/r#30" });
    expect(ref).toHaveAttribute("href", "https://github.com/o/r/issues/30");
    expect(ref).toHaveTextContent("o/r#30");
    // Newest first: the issue above triage.
    const entries = within(log).getAllByRole("listitem");
    expect(entries[0]).toHaveTextContent("GitHub issue");
    expect(entries[entries.length - 1]).toHaveTextContent("Triage");
  });

  it("says a rule decided when triage recorded no model, and nothing of the kind on a copy without triage's words", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "done", path: "decline", leaseExpiresAt: null, summary: { triage: { decision: "decline", rule: "counter-check-zero", reason: "The recount found no errors." } } })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "The recount found no errors.", 9000)]));
    expect(screen.getByText(/Decided by the rule/)).toHaveTextContent("Decided by the rule counter-check-zero, with no model call.");
    // An older run: the rule says the model decided, its name was not recorded, and no rule is said to have decided.
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "done", path: "decline", leaseExpiresAt: null, summary: { triage: { decision: "decline", rule: "model-decline", reason: "Not a code defect." } } })], false));
    expect(screen.getByText(/The model's reasoning/)).toHaveTextContent("The model's reasoning, as triage recorded it.");
    expect(screen.queryByText(/Decided by the rule/)).toBeNull();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "done", path: "decline", leaseExpiresAt: null, summary: { triage: { decision: "decline", rule: "model-decline", model: "gemini-x" } } })], false));
    expect(screen.queryByText(/Decided by a rule|The model's reasoning|Suspected cause/)).toBeNull();
  });

  it("does not link an issue that was not opened, or whose URL isn't https", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { summary: { issue: { state: "dry-run" } } })], false));
    expect(screen.queryByRole("link", { name: /Issue #/ })).toBeNull();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { summary: { issue: { state: "opened", number: 3, url: "javascript:alert(1)" } } })], false));
    expect(screen.queryByRole("link", { name: /Issue #/ })).toBeNull();
  });

  it("draws a reopened run from its latest reopening, says it was reopened, and keeps the earlier rounds (#285)", () => {
    const HOUR = 3_600_000;
    const reopen = "Declined earlier; triaged again: the occurrences grew past the burst threshold since the decline";
    renderRuns();
    act(() =>
      mocks.cyclesCb!(
        [cycle("inc-a_r0", { state: "declined", path: "decline", leaseExpiresAt: null, createdAt: ts(now - 3 * HOUR - 20_000), updatedAt: ts(now - HOUR + 14_100), summary: { triage: { decision: "decline", rule: "model-decline", reason: "third reason" } } })],
        false
      )
    );
    act(() =>
      mocks.eventsCb!([
        event(1, "cycle", "started", "Attempt 1", 3 * HOUR + 20_000),
        event(2, "triage", "decision", "first reason", 3 * HOUR + 9000),
        event(3, "cycle", "reconsidered", reopen, 2 * HOUR),
        event(4, "triage", "decision", "second reason", 2 * HOUR - 10_000),
        event(5, "cycle", "reconsidered", reopen, HOUR),
        event(6, "triage", "decision", "third reason", HOUR - 14_000),
      ])
    );
    // The step is timed within its own round: seconds, never the hours between the rounds.
    const pipeline = screen.getByRole("region", { name: "Pipeline" });
    expect(pipeline).toHaveTextContent("14 s from the latest reopening to the last update");
    expect(pipeline).not.toHaveTextContent(/\d+ h \d+ min/);
    const rounds = screen.getByTestId("run-rounds");
    expect(rounds).toHaveTextContent("Round 3: this run was reopened 2 times.");
    expect(rounds).toHaveTextContent(`${reopen}.`);
    // The latest round's step in the log, then what the earlier rounds ended on, newest first.
    const log = within(screen.getByRole("list", { name: "Step log" })).getAllByRole("listitem");
    expect(log).toHaveLength(1);
    expect(log[0]).toHaveTextContent("third reason");
    const earlier = [...screen.getByRole("list", { name: "Earlier rounds" }).querySelectorAll(":scope > li")];
    expect(earlier.map((li) => li.textContent)).toEqual([expect.stringContaining("Round 2 of 3"), expect.stringContaining("Round 1 of 3")]);
    expect(earlier[0]).toHaveTextContent("second reason");
    expect(earlier[0]).toHaveTextContent("ended on triage · 10 s long");
    expect(earlier[1]).toHaveTextContent("first reason");
    // Each earlier round is folded, like an accordion, and opens on its own line.
    const folds = earlier.map((li) => li.querySelector("details")!);
    expect(folds.every((d) => !d.open)).toBe(true);
    fireEvent.click(within(earlier[0] as HTMLElement).getByText(/Round 2 of 3/));
    expect(folds[0]!.open).toBe(true);
    expect(folds[1]!.open).toBe(false);
  });

  it("keeps a step an earlier round reached on the track, and a step that failed unexpectedly in red, both in the step log", () => {
    const HOUR = 3_600_000;
    renderRuns();
    act(() =>
      mocks.cyclesCb!(
        [cycle("inc-a_r0", { state: "waiting-human", path: "human", leaseExpiresAt: null, createdAt: ts(now - 2 * HOUR), updatedAt: ts(now - HOUR + 6000) })],
        false
      )
    );
    act(() =>
      mocks.eventsCb!([
        event(1, "triage", "decision", "first", 2 * HOUR - 1000),
        event(2, "fix", "proposed", "patch", 2 * HOUR - 2000),
        event(3, "verify", "passed", "green", 2 * HOUR - 3000),
        event(4, "review", "error", "The reviewer returned nothing usable.", 2 * HOUR - 4000),
        event(5, "cycle", "reconsidered", "Retried at an operator's request", HOUR),
        event(6, "triage", "decision", "again", HOUR - 1000),
        event(7, "fix", "proposed", "patch again", HOUR - 2000),
        event(8, "verify", "rejected", "The patch does not apply to the checkout.", HOUR - 3000),
        event(9, "notify", "failed", "Slack refused the message.", HOUR - 4000),
      ])
    );
    const steps = screen.getByRole("list", { name: "Steps" });
    const review = steps.querySelector('[data-step="review"]')!;
    expect(review).toHaveAttribute("data-status", "not-reached");
    expect(review).toHaveTextContent("Not reached this round · round 1: failed (error)");
    expect(screen.getByRole("list", { name: "Also recorded" })).toHaveTextContent("Tell a person: failed");
    const log = within(screen.getByRole("list", { name: "Step log" })).getAllByRole("listitem");
    expect(log[0]).toHaveTextContent("Tell a personFailed: failed");
    const round1 = within(screen.getByRole("list", { name: "Round 1" })).getAllByRole("listitem");
    expect(round1[0]).toHaveTextContent("Adversarial reviewFailed: error");
    expect(round1[0]).toHaveTextContent("The reviewer returned nothing usable.");
  });

  it("says nothing about rounds for a run that was never reopened", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "declined", path: "decline", leaseExpiresAt: null })], false));
    act(() => mocks.eventsCb!([event(1, "cycle", "started", "Attempt 1", 50_000), event(2, "triage", "decision", "a reason", 40_000)]));
    expect(screen.queryByTestId("run-rounds")).toBeNull();
    expect(screen.queryByRole("list", { name: "Earlier rounds" })).toBeNull();
    expect(screen.getByRole("region", { name: "Pipeline" })).toHaveTextContent("from start to the last update");
  });

  it("says when a run has more events than it draws, and only then (#326)", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", path: "human", leaseExpiresAt: null })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000)], false));
    expect(screen.queryByTestId("events-capped")).toBeNull();
    act(() => mocks.eventsCb!([event(301, "escalation", "called", "Called the primary", 40_000)], true));
    const note = screen.getByTestId("events-capped");
    expect(note).toHaveTextContent(`Showing the newest ${EVENT_LIMIT} events of this run; older ones are not drawn`);
    expect(screen.getByRole("region", { name: "Pipeline" })).toContainElement(note);
  });

  it("does not link a pull request URL that isn't https", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { summary: { pr: { url: "javascript:alert(1)", number: 9 } } })], false));
    expect(screen.queryByRole("link", { name: /Pull request #/ })).toBeNull();
  });

  it("opens a linked run that is not among the newest, read by its id, rather than the first in the list", async () => {
    mocks.readCycle.mockResolvedValue(cycle("old_r1", { incidentId: "old", recurrence: 1, state: "declined", leaseExpiresAt: null }));
    renderRuns("/runs?run=old_r1");
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
    expect(await screen.findByRole("heading", { name: "old" })).toBeInTheDocument();
    expect(mocks.readCycle).toHaveBeenCalledWith("old_r1", "demo");
  });

  describe("a linked run that is not listed never shows another run in its place (#219)", () => {
    const detail = () => screen.getByRole("region", { name: "Run detail" });

    it("says it is loading while the read by id is pending", () => {
      mocks.readCycle.mockReturnValue(new Promise(() => {}));
      renderRuns("/runs?run=old_r1");
      act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
      expect(within(detail()).getByText("Loading this run…")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "inc-a" })).toBeNull();
      expect(mocks.subscribedEvents).toEqual([]);
    });

    it("says it couldn't read the run when the read fails", async () => {
      mocks.readCycle.mockRejectedValue(new Error("denied"));
      renderRuns("/runs?run=old_r1");
      act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
      expect(await within(detail()).findByRole("alert")).toHaveTextContent("Couldn't read this run");
      expect(screen.queryByRole("heading", { name: "inc-a" })).toBeNull();
      expect(mocks.subscribedEvents).toEqual([]);
    });

    it("says there is no such run when the read finds none", async () => {
      mocks.readCycle.mockResolvedValue(null);
      renderRuns("/runs?run=old_r1");
      act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
      expect(await within(detail()).findByText(/No such run/)).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "inc-a" })).toBeNull();
      expect(mocks.subscribedEvents).toEqual([]);
    });

    it("reads a linked run again once it was listed and dropped out, never showing the earlier answer", async () => {
      mocks.readCycle.mockResolvedValue(null);
      renderRuns("/runs?run=old_r1");
      act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
      expect(await within(detail()).findByText(/No such run/)).toBeInTheDocument();
      act(() => mocks.cyclesCb!([cycle("old_r1", { incidentId: "old" }), cycle("inc-a_r0")], true));
      expect(screen.getByRole("heading", { name: "old" })).toBeInTheDocument();
      mocks.readCycle.mockClear();
      mocks.readCycle.mockReturnValue(new Promise(() => {}));
      act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
      expect(within(detail()).getByText("Loading this run…")).toBeInTheDocument();
      expect(mocks.readCycle).toHaveBeenCalledWith("old_r1", "demo");
    });

    it("opens the linked run even when the filter hides it, rather than the first one shown", () => {
      renderRuns("/runs?path=pr&run=inc-b_r0");
      act(() => mocks.cyclesCb!([cycle("inc-a_r0", { path: "pr" }), cycle("inc-b_r0", { path: "decline" })], false));
      expect(screen.getByRole("heading", { name: "inc-b" })).toBeInTheDocument();
    });
  });

  it("reads nothing by id when the linked run is in the list", () => {
    renderRuns("/runs?run=inc-a_r0");
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
    expect(mocks.readCycle).not.toHaveBeenCalled();
  });

  it("says when the list is capped", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
    expect(screen.getByText(/^Showing the 50 most recently updated runs/)).toBeInTheDocument();
  });

  it("reads older runs on request, says it is loading until they arrive, and keeps the runs already shown", async () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
    expect(mocks.cycleLimits).toEqual([50]);
    expect(screen.getByText("Showing the 50 most recently updated runs.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show older runs" }));
    expect(mocks.cycleLimits).toEqual([50, 100]);
    expect(screen.getByRole("button", { name: "Loading older runs…" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "inc-a" })).toBeInTheDocument();

    act(() => mocks.cyclesCb!([cycle("inc-a_r0"), cycle("old_r0", { updatedAt: ts(now - 3 * 86_400_000) })], false));
    expect(screen.queryByRole("button", { name: /older runs/ })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Runs" })).getByText("old")).toBeInTheDocument();
  });

  it("stops offering older runs at the ceiling, and says older ones are not listed", async () => {
    renderRuns();
    for (let n = 50; n < 500; n += 50) {
      act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
      await userEvent.click(screen.getByRole("button", { name: "Show older runs" }));
    }
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
    expect(mocks.cycleLimits.at(-1)).toBe(500);
    expect(screen.queryByRole("button", { name: /older runs/ })).toBeNull();
    expect(screen.getByText("Showing the 500 most recently updated runs; older ones are not listed.")).toBeInTheDocument();
  });

  describe("pages of 10", () => {
    // 27 runs, newest first: run-00 is the newest.
    const many = () => Array.from({ length: 27 }, (_, i) => cycle(`run-${String(i).padStart(2, "0")}_r0`, { updatedAt: ts(now - 1000 - i * 1000) }));
    const listed = () => within(screen.getByRole("region", { name: "Runs" })).getAllByRole("listitem");

    it("shows 10 runs at a time, newest first, and pages through the rest", async () => {
      renderRuns();
      act(() => mocks.cyclesCb!(many(), false));
      expect(screen.getByRole("heading", { name: "All runs · 27" })).toBeInTheDocument();
      expect(listed()).toHaveLength(10);
      const pager = screen.getByRole("navigation", { name: "Runs pages" });
      expect(pager).toHaveTextContent("Page 1 of 3 · 1–10 of 27");
      expect(within(pager).getByRole("button", { name: "Newer" })).toBeDisabled();

      await userEvent.click(within(pager).getByRole("button", { name: "Older" }));
      expect(pager).toHaveTextContent("Page 2 of 3 · 11–20 of 27");
      expect(listed()[0]).toHaveTextContent("run-10");
      await userEvent.click(within(pager).getByRole("button", { name: "Older" }));
      expect(pager).toHaveTextContent("Page 3 of 3 · 21–27 of 27");
      expect(listed()).toHaveLength(7);
      expect(within(pager).getByRole("button", { name: "Older" })).toBeDisabled();
    });

    it("reads incidents only for the page shown", () => {
      renderRuns();
      act(() => mocks.cyclesCb!(many(), false));
      const asked = new Set(mocks.getIncident.mock.calls.map((c) => c[0] as string));
      expect(asked).toEqual(new Set(Array.from({ length: 10 }, (_, i) => `run-${String(i).padStart(2, "0")}`)));
    });

    it("opens a linked run on its own page", () => {
      renderRuns("/runs?run=run-24_r0");
      act(() => mocks.cyclesCb!(many(), false));
      expect(screen.getByRole("navigation", { name: "Runs pages" })).toHaveTextContent("Page 3 of 3");
      expect(screen.getByRole("button", { current: true })).toHaveTextContent("run-24");
    });

    it("offers older runs only from the last page", async () => {
      renderRuns();
      act(() => mocks.cyclesCb!(many(), true));
      expect(screen.queryByRole("button", { name: "Show older runs" })).toBeNull();
      const pager = screen.getByRole("navigation", { name: "Runs pages" });
      await userEvent.click(within(pager).getByRole("button", { name: "Older" }));
      await userEvent.click(within(pager).getByRole("button", { name: "Older" }));
      expect(screen.getByRole("button", { name: "Show older runs" })).toBeInTheDocument();
    });

    it("has no pager for 10 runs or fewer", () => {
      renderRuns();
      act(() => mocks.cyclesCb!(many().slice(0, 10), false));
      expect(screen.queryByRole("navigation", { name: "Runs pages" })).toBeNull();
    });
  });

  it("puts the runs under a heading per day", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0"), cycle("old_r0", { updatedAt: ts(now - 3 * 86_400_000) })], false));
    const list = screen.getByRole("region", { name: "Runs" });
    const days = within(list).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(days[0]).toBe("Today");
    expect(days).toHaveLength(2);
  });

  it("times the step a worker is on, from when the step before ended, and only that step", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 30_000)]));
    const steps = screen.getByRole("list", { name: "Steps" });
    const fix = steps.querySelector('[data-step="fix"]')!;
    expect(fix.getAttribute("data-status")).toBe("running");
    expect(fix).toHaveTextContent(/Running · 0:3\d/);
    expect(steps.querySelectorAll('[data-status="running"]')).toHaveLength(1);
    expect(screen.getByText(/^Running for/)).toBeInTheDocument();
  });

  it("animates nothing on a run no worker holds", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { leaseExpiresAt: ts(now - 1000) })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 30_000)]));
    const steps = screen.getByRole("list", { name: "Steps" });
    expect(steps.querySelectorAll('[data-status="running"]')).toHaveLength(0);
    expect(screen.queryByText(/^Running for/)).toBeNull();
  });

  it("shows a step recorded beside the loop's own apart from the track", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000), event(2, "fix", "declined", "No fix", 20_000), event(3, "notify", "sent", "Told the on-call", 10_000)]));
    expect(screen.getByRole("list", { name: "Steps" }).querySelector('[data-step="notify"]')).toBeNull();
    expect(within(screen.getByRole("list", { name: "Also recorded" })).getByText("Tell a person: sent")).toBeInTheDocument();
    expect(screen.getByText("3 of 6 steps recorded")).toBeInTheDocument();
  });

  it("counts the listed runs by how they stand, each tile a link to that list", () => {
    renderRuns();
    act(() =>
      mocks.cyclesCb!(
        [
          cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" }),
          cycle("inc-b_r0", { state: "declined", leaseExpiresAt: null, path: "decline" }),
          cycle("inc-c_r0", { state: "waiting-human", leaseExpiresAt: null, path: "pr" }),
        ],
        false
      )
    );
    const tiles = screen.getByRole("navigation", { name: "Run counts" });
    expect(within(tiles).getByRole("link", { name: /2\s*Waiting for a human/ })).toHaveAttribute("href", "/runs?state=waiting-human");
    expect(within(tiles).getByRole("link", { name: /1\s*Declined/ })).toHaveAttribute("href", "/runs?state=declined");
    expect(within(tiles).getByRole("link", { name: /1\s*Pull request opened/ })).toHaveAttribute("href", "/runs?path=pr");
    expect(within(tiles).getByRole("link", { name: /3\s*All runs/ })).toHaveAttribute("aria-current", "true");
  });

  it("says the counts cover only the runs read when the list is capped", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], true));
    expect(screen.getByText("Counts cover the 50 most recently updated runs.")).toBeInTheDocument();
  });

  it("splits the error's message from the stack frames written into it, and keeps the raw text on request", async () => {
    mocks.getIncident.mockResolvedValue({
      id: "inc-a",
      functionName: "control-getscenarios",
      errorType: "UnknownError",
      errorMessage: "Error: getScenarios failed at entryFromArgs (file:///w/node_modules/firebase-functions/lib/esm/logger/index.mjs:119:13) at Module.error (file:///w/node_modules/firebase-functions/lib/e",
    });
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    const failed = await screen.findByRole("region", { name: "What failed" });
    expect(within(failed).getByText("getScenarios failed")).toBeInTheDocument();
    expect(within(within(failed).getByRole("list", { name: "Stack frames" })).getAllByRole("listitem")).toHaveLength(2);
    expect(within(failed).getByText(/none points at the app's own code/)).toBeInTheDocument();
    await userEvent.click(within(failed).getByRole("button", { name: "Show the raw message" }));
    expect(within(failed).getByText(/^Error: getScenarios failed at entryFromArgs/)).toBeInTheDocument();
  });

  it("shows the cause the engine stored beside the title, its frames, and both in the raw text (#289)", async () => {
    mocks.getIncident.mockResolvedValue({
      id: "inc-a",
      functionName: "orders-createorder",
      errorType: "UnknownError",
      errorMessage: "Checkout failed",
      errorDetail: "Error: Unknown product: sku-poster\n    at /workspace/lib/functions/src/orders/createOrder.js:22:33\n    at async Transaction.runTransactionOnce (/workspace/node_modules/@google-cloud/firestore/build/src/transaction.js:440:28)",
    });
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "declined", leaseExpiresAt: null, path: "decline" })], false));
    const failed = await screen.findByRole("region", { name: "What failed" });
    expect(within(failed).getByText("Checkout failed")).toBeInTheDocument();
    expect(within(failed).getByText("Cause:").parentElement).toHaveTextContent("Cause: Unknown product: sku-poster");
    const frames = within(within(failed).getByRole("list", { name: "Stack frames" })).getAllByRole("listitem");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveTextContent("/workspace/lib/functions/src/orders/createOrder.js:22:33");
    // One frame is the app's own, so the "every frame is in a dependency" note is not shown.
    expect(within(failed).queryByText(/none points at the app's own code/)).toBeNull();
    await userEvent.click(within(failed).getByRole("button", { name: "Show the raw message" }));
    expect(within(failed).getByText(/^Checkout failed\s+Error: Unknown product: sku-poster/)).toBeInTheDocument();
  });

  it("offers no raw message to open when there is nothing beyond the title, as on a guest's trimmed copy", async () => {
    mocks.getIncident.mockResolvedValue({ id: "inc-a", functionName: "orders-createorder", errorType: "UnknownError", errorMessage: "Checkout failed" });
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "declined", leaseExpiresAt: null, path: "decline" })], false));
    const failed = await screen.findByRole("region", { name: "What failed" });
    expect(within(failed).getByText("Checkout failed")).toBeInTheDocument();
    expect(within(failed).queryByText("Cause:")).toBeNull();
    expect(within(failed).queryByRole("button", { name: /raw message/ })).toBeNull();
  });

  it("says in one line how a finished run ended, and draws the hand-off off the step it came after", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000), event(2, "fix", "declined", "No fix", 20_000)]));
    expect(screen.getByTestId("run-summary")).toHaveTextContent("Handed to a person after draft a fix (declined).");
    const fix = screen.getByRole("list", { name: "Steps" }).querySelector('[data-step="fix"]')!;
    expect(fix).toHaveTextContent("Handed to a person");
  });

  it("replays a finished run from its recorded events, labelled as a replay, and stops on request", async () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000), event(2, "fix", "declined", "No fix", 20_000)]));
    const detail = screen.getByRole("region", { name: "Run detail" });
    await userEvent.click(within(detail).getByRole("button", { name: "Watch replay" }));
    expect(within(detail).getByText("Replaying")).toBeInTheDocument();
    expect(screen.getByTestId("run-summary")).toHaveTextContent(/^Replaying the recorded run\./);
    const steps = within(detail).getByRole("list", { name: "Steps" });
    expect(steps.querySelector('[data-step="triage"]')?.getAttribute("data-status")).toBe("running");
    expect(steps.querySelector('[data-step="fix"]')?.getAttribute("data-status")).toBe("not-reached");
    await userEvent.click(within(detail).getByRole("button", { name: "Stop replay" }));
    expect(steps.querySelector('[data-step="fix"]')?.getAttribute("data-status")).toBe("done");
  });

  it("offers a retry on a run a person was told about, on an open incident, and on a declined one; not on a live run or a closed incident", async () => {
    mocks.getIncident.mockResolvedValue({ id: "inc-a", functionName: "orders-createorder", errorType: "DatabaseError", errorMessage: "x", status: "new" });
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000)]));
    expect(await screen.findByRole("button", { name: "Retry with agent (inc-a)" })).toBeInTheDocument();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "declined", leaseExpiresAt: null, path: "decline" })], false));
    expect(await screen.findByRole("button", { name: "Retry with agent (inc-a)" })).toBeInTheDocument();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
    expect(screen.queryByRole("button", { name: /Retry with agent/ })).toBeNull();
  });

  it("offers no retry once the incident is resolved, or a pull request is open", async () => {
    mocks.getIncident.mockResolvedValue({ id: "inc-a", functionName: "orders-createorder", errorType: "DatabaseError", errorMessage: "x", status: "resolved" });
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000)]));
    await screen.findByRole("region", { name: "Run detail" });
    expect(screen.queryByRole("button", { name: /Retry with agent/ })).toBeNull();
  });

  it("says what a person can do on a run that told one, while the incident is open; not on a dry-run draft or a closed incident", async () => {
    mocks.getIncident.mockResolvedValue({ id: "inc-a", functionName: "orders-getorder", errorType: "UnknownError", errorMessage: "x", status: "new" });
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    act(() => mocks.eventsCb!([event(1, "notify", "sent", "A person was told", 50_000)]));
    const card = await screen.findByRole("region", { name: "What you can do now" });
    expect(card).toHaveAttribute("data-path", "human");
    // The retry sits in the card, once, not also on the hero.
    expect(screen.getAllByRole("button", { name: /Retry with agent/ })).toHaveLength(1);
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "draft" })], false));
    expect(screen.queryByRole("region", { name: "What you can do now" })).toBeNull();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "declined", leaseExpiresAt: null, path: "decline" })], false));
    expect(screen.queryByRole("region", { name: "What you can do now" })).toBeNull();
  });

  it("does not say what a person can do once the incident is closed", async () => {
    mocks.getIncident.mockResolvedValue({ id: "inc-a", functionName: "orders-getorder", errorType: "UnknownError", errorMessage: "x", status: "ignored" });
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "notify" })], false));
    act(() => mocks.eventsCb!([event(1, "notify", "sent", "A person was told", 50_000)]));
    // The incident has been read once its name shows.
    await screen.findAllByText("orders-getorder");
    expect(screen.queryByRole("region", { name: "What you can do now" })).toBeNull();
  });

  it("replays at the speed picked, carries on from where it is when the speed changes, and remembers the choice", () => {
    vi.useFakeTimers();
    try {
      renderRuns();
      act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
      // Recorded 10 s and 40 s into the run.
      act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000), event(2, "fix", "declined", "No fix", 20_000)]));
      const detail = screen.getByRole("region", { name: "Run detail" });
      // One split button: the speed half shows the current speed and opens the menu.
      const speedButton = () => within(detail).getByRole("button", { name: /^Replay speed:/ });
      const pickSpeed = (name: RegExp) => {
        fireEvent.click(speedButton());
        fireEvent.click(within(detail).getByRole("menuitemradio", { name }));
      };
      expect(speedButton()).toHaveAccessibleName("Replay speed: Auto (1×)");
      expect(speedButton()).toHaveTextContent("Auto · 1×");
      fireEvent.click(speedButton());
      expect(within(detail).getByRole("menuitemradio", { name: /^Auto \(1×\)/ })).toHaveAttribute("aria-checked", "true");
      // Each speed says how long this 40 s run takes at it.
      expect(within(detail).getByRole("menuitemradio", { name: /^10×/ })).toHaveTextContent("This run in 4 s.");
      fireEvent.click(within(detail).getByRole("menuitemradio", { name: /^10×/ }));
      expect(within(detail).queryByRole("menu")).toBeNull();
      expect(speedButton()).toHaveTextContent("10×");
      expect(localStorage.getItem("starfish.runs.replaySpeed")).toBe("10");
      fireEvent.click(within(detail).getByRole("button", { name: "Watch replay" }));
      expect(within(detail).getByText("Replaying · 10×")).toBeInTheDocument();
      expect(screen.getByTestId("run-summary")).toHaveTextContent(/^Replaying the recorded run at 10× speed\./);
      const steps = within(detail).getByRole("list", { name: "Steps" });
      const status = (step: string) => steps.querySelector(`[data-step="${step}"]`)?.getAttribute("data-status");

      // 2 s on the page = 20 s of the run: triage is recorded, the fix not yet.
      act(() => vi.advanceTimersByTime(2000));
      expect(status("triage")).toBe("done");
      expect(status("fix")).not.toBe("done");

      // Slower from here: it carries on at 20 s in rather than starting again, so triage stays recorded.
      pickSpeed(/^1×/);
      expect(within(detail).getByText("Replaying")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2000));
      expect(status("triage")).toBe("done");
      expect(status("fix")).not.toBe("done");
      expect(within(detail).getByRole("button", { name: "Stop replay" })).toBeInTheDocument();

      // Once it has played to the end, a slower speed does not bring it back mid-way.
      pickSpeed(/^60×/);
      act(() => vi.advanceTimersByTime(2000));
      expect(within(detail).getByRole("button", { name: "Watch replay" })).toBeInTheDocument();
      pickSpeed(/^1×/);
      act(() => vi.advanceTimersByTime(1000));
      expect(within(detail).getByRole("button", { name: "Watch replay" })).toBeInTheDocument();
      expect(status("fix")).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens with the replay speed this browser picked last", () => {
    localStorage.setItem("starfish.runs.replaySpeed", "30");
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000)]));
    expect(screen.getByRole("button", { name: "Replay speed: 30×" })).toHaveTextContent("30×");
  });

  it("offers no replay while a worker holds the run", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 30_000)]));
    expect(screen.queryByRole("button", { name: "Watch replay" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Replay speed/ })).toBeNull();
  });

  it("opens with the run's story on the hero card: the error, its count and how far the run got", async () => {
    mocks.getIncident.mockResolvedValue({ id: "inc-a", functionName: "orders-createorder", errorType: "DatabaseError", errorMessage: "Cannot use undefined", status: "new", occurrenceCount: 11, service: "orders", recurrenceCount: 0 });
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 50_000), event(2, "fix", "proposed", "A guard", 40_000)]));
    expect(await screen.findByText("11 occurrences")).toBeInTheDocument();
    const detail = screen.getByRole("region", { name: "Run detail" });
    expect(within(detail).getByText((_, el) => el?.tagName === "P" && el.textContent === "DatabaseError · Cannot use undefined")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 steps recorded")).toBeInTheDocument();
    expect(screen.getByTestId("run-summary")).toHaveTextContent("Handed to a person after draft a fix (proposed).");
  });

  it("says in the list how a finished run ended, and nothing of the kind for one in progress", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", leaseExpiresAt: null, path: "human" }), cycle("inc-b_r0", { path: "human" })], false));
    const list = screen.getByRole("region", { name: "Runs" });
    expect(within(list).getAllByText("Handed to a person")).toHaveLength(1);
  });

  it("shows each step's recorded details: triage's choice among the levels, the fix's risk, the gate's checks and the review's attacks", () => {
    renderRuns();
    const summary = {
      triage: { decision: "act", rule: "model-act", reason: "A field is undefined.", level: "fix", counterCount: 11, counterWindow: "24h" },
      fix: { outcome: "proposed", risk: "Readers of giftNote", testAdded: true, alternative1: "Drop the field" },
      verify: { status: "passed", files: 1, exitCode: 0 },
      review: { verdict: "block", held: 2, broken: 1, attack1: "held: no note | written as null", attack2: "broken: readers | the slip prints null" },
    };
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { state: "waiting-human", path: "human", leaseExpiresAt: null, summary })], false));
    act(() =>
      mocks.eventsCb!([
        event(1, "triage", "decision", "A field is undefined.", 50_000),
        event(2, "fix", "proposed", "giftNote is undefined with no note", 40_000),
        event(3, "verify", "passed", "Checks passed", 30_000),
        event(4, "review", "block", "3 attacks tried", 20_000),
      ])
    );
    const log = screen.getByRole("list", { name: "Step log" });
    const levels = within(log).getByRole("group", { name: "How far Starfish goes" });
    expect(within(levels).getByText("Log + fix")).toHaveAttribute("aria-current", "true");
    expect(levels).toHaveTextContent("Noise (not chosen)");
    expect(within(log).getByText(/Recount: 11 errors in 24h/)).toBeInTheDocument();
    expect(within(log).getByText("Could break:").parentElement).toHaveTextContent("Readers of giftNote");
    expect(within(log).getByText("Test added")).toBeInTheDocument();
    expect(within(log).getByText(/1 rejected alternative/)).toBeInTheDocument();
    expect(within(log).getByText(/The patch text is not stored/)).toBeInTheDocument();
    expect(within(log).getByText("1 file changed")).toBeInTheDocument();
    const attacks = within(log).getByRole("group", { name: "Attacks tried" });
    expect(attacks).toHaveTextContent("brokenreadersthe slip prints null");
    expect(within(log).getByText("1 broke it")).toBeInTheDocument();
  });

  it("reads oldest first on request, the step in progress last", async () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { stage: "fix" })], false));
    act(() => mocks.eventsCb!([event(1, "triage", "decision", "Act", 30_000)]));
    const entries = () => within(screen.getByRole("list", { name: "Step log" })).getAllByRole("listitem");
    expect(entries()[0]).toHaveTextContent("Draft a fix");
    await userEvent.click(screen.getByRole("button", { name: /Newest first/ }));
    expect(entries()[0]).toHaveTextContent("Triage");
    expect(entries()[1]).toHaveTextContent("Draft a fix");
    expect(screen.getByRole("button", { name: /Oldest first/ })).toBeInTheDocument();
  });

  it("shows a run full width from its card's corner, and back, remembered in this browser", async () => {
    const view = renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
    expect(screen.getByRole("region", { name: "Runs" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Full width" }));
    expect(screen.queryByRole("region", { name: "Runs" })).toBeNull();
    expect(screen.getByRole("region", { name: "Run detail" })).toBeInTheDocument();
    expect(localStorage.getItem("starfish.runs.listHidden")).toBe("1");

    view.unmount();
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
    expect(screen.queryByRole("region", { name: "Runs" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Exit full width" }));
    expect(screen.getByRole("region", { name: "Runs" })).toBeVisible();
    expect(localStorage.getItem("starfish.runs.listHidden")).toBe("0");
  });

  it("keeps the run list when no run is shown, so the way back is never hidden", () => {
    localStorage.setItem("starfish.runs.listHidden", "1");
    mocks.readCycle.mockResolvedValue(null);
    renderRuns("/runs?run=gone_r0");
    act(() => mocks.cyclesCb!([cycle("inc-a_r0")], false));
    expect(screen.getByRole("region", { name: "Runs" })).toBeVisible();
  });
});
