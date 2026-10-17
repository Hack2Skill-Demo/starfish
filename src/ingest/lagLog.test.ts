import { describe, expect, it } from "vitest";
import { INGEST_CHECKPOINT_MESSAGE, ingestCheckpointLine } from "./lagLog.js";

describe("ingestCheckpointLine", () => {
  it("is one JSON line Cloud Logging reads, carrying the lag in seconds", () => {
    const line = ingestCheckpointLine({ lagSeconds: 5400.4, outcome: "ok" })!;
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ severity: "INFO", message: INGEST_CHECKPOINT_MESSAGE, ingestCheckpointLagSeconds: 5400, outcome: "ok" });
  });

  it("writes zero lag as zero", () => {
    expect(JSON.parse(ingestCheckpointLine({ lagSeconds: 0, outcome: "ok" })!).ingestCheckpointLagSeconds).toBe(0);
  });

  it("writes nothing when the run has no lag figure: missing is not zero", () => {
    expect(ingestCheckpointLine({ outcome: "failed" })).toBeUndefined();
    expect(ingestCheckpointLine({ lagSeconds: Number.NaN, outcome: "ok" })).toBeUndefined();
    expect(ingestCheckpointLine({ lagSeconds: -5, outcome: "ok" })).toBeUndefined();
  });
});
