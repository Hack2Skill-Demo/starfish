import { afterEach, describe, expect, it, vi } from "vitest";
import { logStartup, startupLine } from "./startupLog.js";

const NOW = new Date("2026-10-12T15:02:04.000Z");

describe("startupLine (#275)", () => {
  it("is one JSON line Cloud Logging reads as INFO, with both marks and when the process started", () => {
    const line = startupLine("ingest", 121.23456, 1.9876543, NOW);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      severity: "INFO",
      message: "starfish ingest started",
      job: "ingest",
      uptimeSeconds: 121.235,
      codeStartSeconds: 1.988,
      processStartedAt: "2026-10-12T15:00:02.765Z",
    });
  });

  it("says nothing it does not know: a missing uptime is null, never zero", () => {
    expect(JSON.parse(startupLine("agent", null, null, NOW))).toEqual({
      severity: "INFO",
      message: "starfish agent started",
      job: "agent",
      uptimeSeconds: null,
      codeStartSeconds: null,
      processStartedAt: null,
    });
    expect(JSON.parse(startupLine("agent", 3, 1, new Date(Number.NaN))).processStartedAt).toBeNull();
  });
});

describe("logStartup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints the line once, with this module's own mark at or before the uptime now", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logStartup("admin-api");
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0]![0])) as { message: string; uptimeSeconds: number; codeStartSeconds: number };
    expect(parsed.message).toBe("starfish admin-api started");
    expect(parsed.codeStartSeconds).toBeGreaterThan(0);
    expect(parsed.codeStartSeconds).toBeLessThanOrEqual(parsed.uptimeSeconds);
  });

  it("never throws, even when printing fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout closed");
    });
    expect(() => logStartup("verify-runner")).not.toThrow();
  });
});
