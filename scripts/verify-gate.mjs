#!/usr/bin/env node
/**
 * verify-gate.mjs — the CLAUDE.md verification gate, at a fixed output budget.
 * ============================================================================
 *
 * The gate is lint → typecheck → test → build (engine + web/). Run the obvious way, a GREEN gate
 * streams success tables (Vitest's per-file list, coverage tables) that carry
 * exactly one bit of information — the bit already in the exit code. For a
 * human that noise is free; for an agent driving the gate through a tool call
 * every byte becomes context, re-sent on every later request. On a larger
 * codebase this wrapper turned a ~29 KB green run into ~410 bytes.
 *
 * So each step's stdout and stderr go STRAIGHT TO A FILE in .verify-logs/, and
 * one line per step is printed. On failure, only the lines matching that step's
 * diagnostic patterns are printed, capped at a byte budget with the overflow
 * counted rather than shown; an unanticipated failure shape falls back to the
 * log's tail, so a failure is never silent. Nothing is discarded.
 *
 * USAGE
 *   pnpm run verify                     # the whole gate
 *   pnpm run verify -- --only=lint,test
 *   pnpm run verify -- --bail           # stop at the first failing step
 *   pnpm run verify -- --budget=6000    # chars of diagnostics per failing step
 *   pnpm run verify -- --only=coverage  # coverage percentages, no per-file table
 *
 * All steps run by default (no --bail): stopping at the first failure hides the
 * type error behind the lint error, so you fix, rerun, fix, rerun — each rerun a
 * full gate. Surfacing every failure in one pass is cheaper.
 *
 * Zero new dependencies: node:fs / node:child_process / node:path only.
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Walk up to the pnpm workspace manifest. */
export function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir, "..");
    dir = parent;
  }
}

/** On Windows `pnpm` is a .cmd batch file spawnSync cannot exec by bare name. */
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/**
 * Patterns that appear in EVERY runner's failure output regardless of step.
 * `ELIFECYCLE` is pnpm's own marker for a script that exited non-zero, so it is
 * the reliable backstop when a tool fails in a shape its own patterns miss.
 *
 * Never use the `g` flag in any pattern here or in a step: a global regex
 * carries `lastIndex` between `.test()` calls and would skip every other line.
 */
export const GENERIC_PATTERNS = [
  /ELIFECYCLE/,
  /\bENOENT\b/,
  /command not found/,
  /JavaScript heap out of memory/,
  /\bKilled\b/,
];

/**
 * The gate. `script` is the root package.json script each step shells out to.
 *
 * `optional: true` keeps a step out of the default run; reach it with --only.
 * `coverage` is the only one today: it is not a gate step, but iterating on it
 * locally is exactly when you want the percentages without the per-file table.
 *
 * `patterns` are deliberately CASE-SENSITIVE and word-bounded. A loose /fail/i
 * matches `PASS .../signInFailure.test.ts` on a green run and would turn the
 * extract back into the log dump this exists to avoid.
 */
export const STEPS = [
  {
    key: "lint",
    script: "lint",
    patterns: [
      // eslint stylish: "  12:5  error  Unexpected any  @typescript-eslint/no-explicit-any"
      /^\s*\d+:\d+\s+error\s/,
      // The file header that gives those coordinates a file — only when the log
      // has at least one error, since eslint also prints headers for warnings.
      (line, all) =>
        /^(\/|[A-Za-z]:\\).*\.(ts|tsx|js|mjs)$/.test(line) &&
        all.some((l) => /^\s*\d+:\d+\s+error\s/.test(l)),
      /^\s*✖\s+\d+\s+problems?\s+\([1-9]\d*\s+errors?/,
    ],
  },
  {
    key: "typecheck",
    script: "typecheck",
    patterns: [/error TS\d+/],
  },
  {
    key: "test",
    script: "test",
    patterns: [
      /\bFAIL\b/,
      /✕|×/,
      /Tests\s+\d+ failed/,
      /Test Files\s+\d+ failed/,
      /AssertionError/,
      /Unhandled Rejection/,
    ],
  },
  {
    key: "build",
    script: "build",
    // The web app's Vite build. Vite's green output is an asset table plus
    // "built in"; none of these appear in it.
    patterns: [
      /error during build/,
      /\[vite\]:/,
      /\bError:/,
      /Could not resolve/,
      /Rollup failed/,
      /\bRollupError\b/,
      /error TS\d+/,
    ],
  },
  {
    key: "coverage",
    script: "test:coverage",
    optional: true,
    // The one step whose GREEN result carries information — the percentages.
    summarize: (logText) => formatCoverageRows(summarizeCoverage(logText)),
    patterns: [/\bFAIL\b/, /✕|×/, /Tests\s+\d+ failed/, /coverage threshold .* not met/],
  },
];

/**
 * Reduce a failed step's log to the smallest text that still identifies the
 * failure.
 *
 * Returns matching lines when the step's patterns hit, and the log's tail when
 * they do not — an unrecognised failure must never print nothing, because
 * "green summary, non-zero exit, no explanation" is the worst outcome this
 * runner could produce. `omitted` counts what the caps dropped so the summary
 * can say so out loud rather than silently truncating.
 */
export function extractFailureLines(logText, patterns, opts = {}) {
  const maxLines = opts.maxLines ?? 40;
  const maxChars = opts.maxChars ?? 2000;
  const tailLines = opts.tailLines ?? 15;
  const maxLineWidth = opts.maxLineWidth ?? 240;

  const all = String(logText).split("\n");
  // A pattern may be a regex OR a predicate `(line, allLines) => boolean`. The
  // predicate form exists for patterns that are only meaningful in the context
  // of the whole log — see the `lint` step's file-header pattern.
  const matches = (p, line) => (typeof p === "function" ? p(line, all) : p.test(line));
  const matched = all.filter((line) => patterns.some((p) => matches(p, line)));

  const mode = matched.length > 0 ? "matched" : "tail";
  const candidates = (
    mode === "matched" ? matched : all.filter((l) => l.trim() !== "").slice(-tailLines)
  ).map((l) => l.trimEnd());

  const lines = [];
  let chars = 0;
  for (const line of candidates) {
    const clipped = line.length > maxLineWidth ? `${line.slice(0, maxLineWidth)}…` : line;
    if (lines.length >= maxLines || chars + clipped.length + 1 > maxChars) break;
    lines.push(clipped);
    chars += clipped.length + 1;
  }

  return { mode, lines, omitted: candidates.length - lines.length, total: candidates.length };
}

/**
 * Pull the `All files` totals out of a coverage log.
 *
 * The point of running coverage is a number, and the report buries it under a
 * per-file table. Two shapes are matched: the bare Jest/Vitest row, and the same
 * row carrying a `pnpm -C <dir>` prefix.
 *
 * A parsed row also fails safe: if the table shape ever changes this returns []
 * and the caller prints nothing rather than garbage — the exit code still
 * carries pass/fail on its own.
 */
export function summarizeCoverage(logText) {
  const rows = [];
  const re =
    /^(?:(\S+)\s+\S*test\S*:\s+)?All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/;
  for (const line of String(logText).split("\n")) {
    const m = line.match(re);
    if (m) {
      rows.push({
        workspace: m[1] ?? "all files",
        stmts: Number(m[2]),
        branch: Number(m[3]),
        funcs: Number(m[4]),
        lines: Number(m[5]),
      });
    }
  }
  return rows;
}

/** Render summarizeCoverage rows as one compact aligned line each. */
export function formatCoverageRows(rows) {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.workspace.length), "workspace".length);
  const cell = (v) => String(v).padStart(8);
  return [
    `${"workspace".padEnd(width)} ${"stmts".padStart(8)} ${"branch".padStart(8)} ${"funcs".padStart(8)} ${"lines".padStart(8)}`,
    ...rows.map(
      (r) => `${r.workspace.padEnd(width)} ${cell(r.stmts)} ${cell(r.branch)} ${cell(r.funcs)} ${cell(r.lines)}`
    ),
  ];
}

/**
 * Resolve --only against the gate, failing loudly on an unknown key.
 * With no --only, optional steps are excluded — naming one is the opt-in.
 */
export function selectSteps(steps, only) {
  if (!only || only.length === 0) return steps.filter((s) => !s.optional);
  const known = new Set(steps.map((s) => s.key));
  const unknown = only.filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown step(s): ${unknown.join(", ")} — valid keys: ${steps.map((s) => s.key).join(", ")}`
    );
  }
  return steps.filter((s) => only.includes(s.key));
}

export function parseArgs(argv) {
  const opts = { only: null, bail: false, maxChars: 2000, maxLines: 40, help: false };
  for (const arg of argv) {
    // pnpm 9 forwards the `--` separator itself as an argument, so the usage
    // this file documents (`pnpm run verify -- --only=lint`) arrives here as
    // ["--", "--only=lint"]. Ignore it rather than rejecting the one invocation
    // everyone is told to type.
    if (arg === "--") continue;
    if (arg === "--bail") opts.bail = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--only=")) {
      opts.only = arg
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--budget=")) {
      const n = Number(arg.slice("--budget=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--budget must be a positive number, got: ${arg}`);
      opts.maxChars = n;
    } else if (arg.startsWith("--max-lines=")) {
      const n = Number(arg.slice("--max-lines=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--max-lines must be a positive number, got: ${arg}`);
      opts.maxLines = n;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const USAGE = `verify-gate — run the CLAUDE.md gate without dumping its logs

  pnpm run verify                      lint, typecheck, test, build
  pnpm run verify -- --only=lint,test  run a subset
  pnpm run verify -- --bail            stop at the first failure
  pnpm run verify -- --budget=6000     chars of diagnostics printed per failing step
  pnpm run verify -- --max-lines=80    lines of diagnostics printed per failing step
  pnpm run verify -- --only=coverage   coverage, reported as percentages only

Steps: ${STEPS.filter((s) => !s.optional)
  .map((s) => s.key)
  .join(", ")}
Opt-in: ${STEPS.filter((s) => s.optional)
  .map((s) => s.key)
  .join(", ")} (--only)
Full logs are always written to .verify-logs/<step>.log — nothing is discarded.`;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`verify: ${err.message}`);
    process.exit(2);
  }

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  let steps;
  try {
    steps = selectSteps(STEPS, opts.only);
  } catch (err) {
    console.error(`verify: ${err.message}`);
    process.exit(2);
  }

  const repoRoot = findRepoRoot(SCRIPT_DIR);
  const logDir = path.join(repoRoot, ".verify-logs");
  mkdirSync(logDir, { recursive: true });

  // Every byte this process prints is tallied, so the closing line can state the
  // ratio it exists to improve rather than assert it.
  let printedChars = 0;
  const out = (line = "") => {
    printedChars += line.length + 1;
    console.log(line);
  };

  out(`verify: ${steps.length} step(s) → .verify-logs/ (logs stay on disk; only failures print)`);

  const results = [];
  const startedAll = Date.now();

  for (const step of steps) {
    const logPath = path.join(logDir, `${step.key}.log`);
    const started = Date.now();

    // The child writes to this fd directly. Its output never enters this
    // process's memory, so the log's size is irrelevant to what we print.
    const fd = openSync(logPath, "w");
    let status;
    let spawnError = null;
    try {
      const res = spawnSync(PNPM, ["run", step.script], {
        cwd: repoRoot,
        stdio: ["ignore", fd, fd],
        env: process.env,
      });
      if (res.error) {
        spawnError = res.error.message;
        status = null;
      } else if (res.signal) {
        spawnError = `killed by signal ${res.signal}`;
        status = null;
      } else {
        status = res.status;
      }
    } finally {
      closeSync(fd);
    }

    const durationMs = Date.now() - started;
    const bytes = existsSync(logPath) ? statSync(logPath).size : 0;
    const ok = status === 0;
    results.push({ step, ok, status, spawnError, durationMs, bytes, logPath });

    const mark = ok ? "✓" : "✗";
    const relLog = path.relative(repoRoot, logPath);
    out(
      `${mark} ${step.key.padEnd(14)} ${fmtDuration(durationMs).padStart(7)}  ${fmtBytes(bytes).padStart(8)}  ${relLog}`
    );

    // A step may declare a summary worth printing regardless of outcome. Read
    // the log once and reuse it for both the summary and any failure extract.
    let logText = null;
    const readLog = () => {
      if (logText === null) logText = bytes > 0 ? readFileSync(logPath, "utf8") : "";
      return logText;
    };

    if (step.summarize) {
      for (const line of step.summarize(readLog())) out(`    ${line}`);
    }

    if (!ok) {
      if (spawnError) out(`    could not run: ${spawnError}`);
      const extract = extractFailureLines(readLog(), [...step.patterns, ...GENERIC_PATTERNS], {
        maxChars: opts.maxChars,
        maxLines: opts.maxLines,
      });
      if (extract.mode === "tail" && extract.lines.length > 0) {
        out(`    (no diagnostic pattern matched — showing the log's tail)`);
      }
      for (const line of extract.lines) out(`    ${line}`);
      if (extract.omitted > 0) {
        out(`    … ${extract.omitted} more line(s) — full detail in ${relLog}`);
      }
      if (opts.bail) break;
    }
  }

  const failed = results.filter((r) => !r.ok);
  const ran = results.length;
  const capturedBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const skipped = steps.length - ran;

  out();
  out(
    `verify: ${ran - failed.length}/${ran} passed${failed.length ? `, ${failed.length} failed` : ""}` +
      `${skipped > 0 ? `, ${skipped} not run (--bail)` : ""} in ${fmtDuration(Date.now() - startedAll)}`
  );
  out(
    `verify: ${fmtBytes(capturedBytes)} of tool output captured to disk, ${fmtBytes(printedChars)} printed`
  );

  if (failed.length > 0) process.exit(1);
}

// Importable for the test suite without executing the gate.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
