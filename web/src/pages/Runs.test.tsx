import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCycle, parseEvent, type CycleRow, type EventRow } from "../lib/runsModel";

type CyclesCb = (rows: CycleRow[], capped: boolean) => void;
type EventsCb = (rows: EventRow[]) => void;

const mocks = vi.hoisted(() => ({
  env: { environment: "demo", ready: true, settingsUnavailable: false },
  cyclesCb: undefined as undefined | ((rows: unknown[], capped: boolean) => void),
  cyclesErr: undefined as undefined | ((e: Error) => void),
  eventsCb: undefined as undefined | ((rows: unknown[]) => void),
  unsubCycles: vi.fn(),
  unsubEvents: vi.fn(),
  subscribedEvents: [] as string[],
  readCycle: vi.fn(),
}));

vi.mock("../lib/useSettings", () => ({ useEnvironment: () => mocks.env }));
vi.mock("../components/EngineStatus", () => ({ EngineStatus: ({ environment }: { environment: string }) => <div data-testid="engine">{environment}</div> }));
vi.mock("../lib/runs", async (orig) => ({
  ...(await orig<typeof import("../lib/runs")>()),
  subscribeCycles: (_env: string, ok: CyclesCb, err: (e: Error) => void) => {
    mocks.cyclesCb = ok as never;
    mocks.cyclesErr = err;
    return mocks.unsubCycles;
  },
  readCycle: mocks.readCycle,
  subscribeEvents: (id: string, _env: string, ok: EventsCb) => {
    mocks.subscribedEvents.push(id);
    mocks.eventsCb = ok as never;
    return mocks.unsubEvents;
  },
}));

import Runs from "./Runs";

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
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Runs />
    </MemoryRouter>
  );
}

describe("Runs page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscribedEvents.length = 0;
    mocks.cyclesCb = mocks.cyclesErr = mocks.eventsCb = undefined;
    mocks.env = { environment: "demo", ready: true, settingsUnavailable: false };
  });

  it("says the settings couldn't be read, so an empty list isn't taken for a quiet day (#143)", () => {
    mocks.env = { environment: "build-label", ready: true, settingsUnavailable: true };
    renderRuns();
    act(() => mocks.cyclesCb!([], false));
    const notice = screen.getByText(/Couldn't read the runtime settings/);
    expect(notice).toHaveTextContent("runs are filtered");
    expect(notice).toHaveTextContent("build-label");
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
    // Engine health sits in the page header, for the environment shown.
    expect(screen.getByTestId("engine")).toHaveTextContent("demo");
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
    expect(screen.getByTestId("path-filter")).toHaveTextContent("Missing-index heals that held through their window (1)");
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
    expect(screen.queryByRole("link", { name: /Open the pull request/ })).toBeNull();
    act(() => mocks.eventsCb!([event(1, "pr", "opened", "Opened a pull request", 1000)]));
    expect(screen.getByRole("link", { name: /Open the pull request/ })).toHaveAttribute("href", "https://github.com/o/r/pull/9");
  });

  it("does not link a pull request URL that isn't https", () => {
    renderRuns();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { summary: { pr: { url: "javascript:alert(1)", number: 9 } } })], false));
    expect(screen.queryByRole("link", { name: /Pull request/ })).toBeNull();
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
    expect(screen.getByText(/most recently updated runs/)).toBeInTheDocument();
  });
});
