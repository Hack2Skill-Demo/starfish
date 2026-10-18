import { describe, expect, it } from "vitest";
import { section } from "./promptSections.js";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("section (#416)", () => {
  it("shows a body that fits whole, under its title, and says no cut", () => {
    expect(section({ title: "PATCH", body: "a\nb", redact: "shape", max: 100 })).toEqual({ lines: ["PATCH", "a\nb"], cut: null });
  });

  it("cuts by whole lines from the head, and marks the cut in the title and where the lines were", () => {
    const r = section({ title: "T", body: numbered(100), redact: "shape", max: 50 });
    expect(r.cut).toMatchObject({ from: 1, of: 100 });
    expect(r.lines[0]).toBe(`T (CUT: lines 1–${r.cut!.to} of 100 shown)`);
    expect(r.lines[1]).toBe("line 1");
    expect(r.lines.at(-1)).toBe(`[… lines ${r.cut!.to + 1}–100 not shown …]`);
    expect(r.cut!.shownChars).toBeLessThanOrEqual(50);
  });

  it("keeps the tail when asked, where a test run says what failed", () => {
    const r = section({ title: "OUT", body: numbered(100), redact: "pii", max: 30, keep: "tail" });
    expect(r.cut).toMatchObject({ to: 100, of: 100 });
    expect(r.lines.at(-1)).toBe("line 100");
    expect(r.lines[1]).toBe(`[… lines 1–${r.cut!.from - 1} not shown …]`);
  });

  it("windows around a line, keeping lines on both sides of it", () => {
    const r = section({ title: "F", body: numbered(1_000), redact: "shape", max: 200, keep: { aroundLine: 700 } });
    expect(r.cut!.from).toBeLessThan(700);
    expect(r.cut!.to).toBeGreaterThan(700);
    expect(r.lines).toContain("line 700");
    expect(r.lines[1]).toBe(`[… lines 1–${r.cut!.from - 1} not shown …]`);
    expect(r.lines.at(-1)).toBe(`[… lines ${r.cut!.to + 1}–1000 not shown …]`);
  });

  it("clamps a line past the end to the last line", () => {
    const r = section({ title: "F", body: numbered(100), redact: "shape", max: 40, keep: { aroundLine: 5_000 } });
    expect(r.cut!.to).toBe(100);
  });

  it("cuts one line longer than the whole budget, and says how much of it is missing", () => {
    const r = section({ title: "M", body: "x".repeat(1_000), redact: "shape", max: 100 });
    expect(r.lines).toEqual(["M (CUT: line 1 of 1 shown)", "x".repeat(100), "[… 900 more characters of this line not shown …]"]);
  });

  it("uses the caller's title for a cut when it gives one", () => {
    const r = section({ title: "PATCH", body: numbered(50), redact: "shape", max: 20, markCut: (c) => `PATCH (only ${c.to} lines)` });
    expect(r.lines[0]).toBe(`PATCH (only ${r.cut!.to} lines)`);
  });

  it("redacts before it cuts, by the kind asked: shapes for code, everything for log text", () => {
    const code = section({ title: "C", body: `const k = "${SEEDED_SECRETS.stripe}";\nconst token = getToken();`, redact: "shape", max: 1_000 });
    expect(code.lines.join("\n")).not.toContain(SEEDED_SECRETS.stripe);
    expect(code.lines.join("\n")).toContain("const token = getToken();");
    const log = section({ title: "L", body: `mail bob@example.com\npassword=hunter2`, redact: "pii", max: 1_000 });
    expect(log.lines.join("\n")).not.toContain("bob@example.com");
    expect(log.lines.join("\n")).not.toContain("hunter2");
  });

  it("bounds a huge body before redacting it, and still keeps whole lines and the right numbers", () => {
    const body = numbered(100_000);
    const head = section({ title: "H", body, redact: "pii", max: 100 });
    expect(head.cut).toMatchObject({ from: 1, of: 100_000 });
    const tail = section({ title: "T", body, redact: "pii", max: 100, keep: "tail" });
    expect(tail.cut).toMatchObject({ to: 100_000, of: 100_000 });
    expect(tail.lines.at(-1)).toBe("line 100000");
    const around = section({ title: "A", body, redact: "shape", max: 100, keep: { aroundLine: 90_000 } });
    expect(around.lines).toContain("line 90000");
    expect(around.lines[1]).toBe(`[… lines 1–${around.cut!.from - 1} not shown …]`);
  });
});
