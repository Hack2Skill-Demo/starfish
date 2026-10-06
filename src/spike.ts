/**
 * The week-one spike.
 *
 * One question, asked before any infrastructure gets built: given a real incident
 * and the relevant source, does Gemini produce a patch a human would have written
 * — and does it correctly decline when the incident isn't worth acting on?
 *
 * Every fixture carries ground truth (what a correct fix, or a correct decline,
 * looks like), so the output is scored rather than judged on how plausible it
 * reads. The fixtures in this repo are synthetic but realistic; the harness runs
 * the same way over a private set of real incidents with shipped fixes.
 *
 * A fix-quality fixture with a `checkout` (#4) has its patch RUN, not just printed: the
 * fixture's evaluator must fail on a disposable copy of the pre-fix source before the
 * patch, and the patch must then apply as given (no manual repair), pass the target's own
 * command, and make the evaluator pass, all through the verify gate
 * (src/scoreboard/evaluate.ts). An empty patch on a fix case is a failure. A fixture with
 * no checkout says its patch was not checked: a plausible diff is not a pass.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { askJson, modelName } from "./vertex.js";
import { redactPii, redactCredentials } from "./ingest/redact.js";
import { verifyPatch } from "./agent/verifyGate.js";
import { checkReproduces, evaluatePatch, type CheckoutUnderTest } from "./scoreboard/evaluate.js";
import type { SpikeFixture, TriageVerdict } from "./types.js";

const FIXTURE_DIR = join(import.meta.dirname, "../fixtures/incidents");

const TRIAGE_SYSTEM = `You are an on-call engineer for a small team with no dedicated ops staff.
You are shown one production incident. Decide whether it is URGENT — a crash or broken
user-facing flow, with real or climbing impact — or NOT urgent.

Weigh the occurrence count, the independent log counter-check, the environment, and whether
the error describes real user-facing breakage.

Read the counter-check for what it is: every ERROR-severity log entry for the whole FUNCTION
over its window (usually 24h), counted straight from Cloud Logging. The occurrence count is
for this one incident, over its lifetime. So they will rarely be equal, and that alone means
nothing. What matters is a counter-check of ZERO against an incident claiming occurrences: the
logs show no error at all for the function, which strongly suggests the incident is
monitoring noise rather than a live fault. A missing counter-check means it could not be
run — not that it read zero.

Declining to act is a valid and often correct answer.`;

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    urgent: { type: "boolean" },
    reasoning: { type: "string", description: "Which signals drove the call." },
    suspectedCause: {
      type: ["string", "null"],
      description: "Where the fault lives. Null when not urgent.",
    },
  },
  required: ["urgent", "reasoning", "suspectedCause"],
};

const FIX_SYSTEM = `You are fixing one production bug. Produce the MINIMAL change that
addresses the root cause — not a refactor, not surrounding cleanup.

"patch" is a unified diff against the files you were shown.
If the source you were given is insufficient to fix it confidently, say so in "rootCause"
and return an empty "patch". Guessing is worse than declining.`;

interface ProposedFix {
  rootCause: string;
  patch: string;
  risk: string;
}

const FIX_SCHEMA = {
  type: "object",
  properties: {
    rootCause: { type: "string" },
    patch: { type: "string", description: "Unified diff, or empty when declining." },
    risk: { type: "string" },
  },
  required: ["rootCause", "patch", "risk"],
};

function renderIncident(f: SpikeFixture, context: { path: string; excerpt: string }[]): string {
  // Source excerpts get shape-only redaction: `token = getToken()` is code, and
  // rewriting it would corrupt the patch context the fixer works from.
  const ctx = context
    .map((c) => `--- ${c.path} ---\n${redactCredentials(c.excerpt)}`)
    .join("\n\n");
  // Production text like any other: nothing credential-shaped reaches the model.
  return [`INCIDENT`, redactPii(JSON.stringify(f.incident, null, 2)), ``, `SOURCE CONTEXT`, ctx].join("\n");
}

interface LoadedFixture {
  fixture: SpikeFixture;
  /** The checkout, resolved against the fixture file, when the fixture has one. */
  checkout?: CheckoutUnderTest & { verifyCommand: string; files: string[] };
}

/** A path under `base`, or a thrown error: a fixture must not point the harness elsewhere on the machine. */
function under(base: string, rel: string): string {
  const full = resolve(base, rel);
  const r = relative(base, full);
  if (r === "" || r.startsWith("..") || resolve(base, r) !== full) throw new Error(`"${rel}" must stay inside ${base}`);
  return full;
}

function resolveCheckout(fixtureFile: string, c: NonNullable<SpikeFixture["checkout"]>): NonNullable<LoadedFixture["checkout"]> {
  const base = dirname(fixtureFile);
  const repoDir = under(base, c.repo);
  const evaluatorDir = under(base, c.evaluator.dir);
  // The model is shown `files` from the repo; the evaluator must not be somewhere a listed file could come from.
  if (!relative(repoDir, evaluatorDir).startsWith("..") || !relative(evaluatorDir, repoDir).startsWith("..")) {
    throw new Error("checkout.evaluator.dir must lie outside checkout.repo");
  }
  for (const f of c.files) if (!existsSync(under(repoDir, f))) throw new Error(`checkout file "${f}" is not in the repo`);
  return { repoDir, evaluator: { dir: evaluatorDir, command: c.evaluator.command }, verifyCommand: c.verifyCommand, files: c.files };
}

async function loadFixtures(): Promise<LoadedFixture[]> {
  const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".json"));
  return Promise.all(
    files.map(async (f) => {
      const fixture = JSON.parse(await readFile(join(FIXTURE_DIR, f), "utf8")) as SpikeFixture;
      return { fixture, ...(fixture.checkout && { checkout: resolveCheckout(join(FIXTURE_DIR, f), fixture.checkout) }) };
    })
  );
}

/**
 * The executable check of one proposed patch (#4): it applies as given, the target's own command passes, and the
 * evaluator passes. Each half prints its rule and exit code: the evidence, not a summary of it.
 */
async function checkPatch(checkout: NonNullable<LoadedFixture["checkout"]>, patch: string): Promise<boolean> {
  const cfg = loadConfig();
  if (cfg.verifyIsolation !== "in-process") {
    console.log("NOT RUN: the model's patch would run in this process; set STARFISH_VERIFY_ISOLATION=in-process to say that is acceptable here.");
    return false;
  }
  const gate = { verifyTimeoutSeconds: cfg.verifyTimeoutSeconds, patchExcludedPaths: cfg.patchExcludedPaths };
  const target = await verifyPatch({ sourceDir: checkout.repoDir, patch, config: { ...gate, verifyCommand: checkout.verifyCommand } });
  console.log(`target command: ${target.status} (${target.rule}, exit ${target.exitCode ?? "none"}, patch ${target.patchSha256.slice(0, 12)})`);
  const after = await evaluatePatch(checkout, patch, gate);
  console.log(`evaluator after the patch: ${after.result.status} (${after.result.rule}, exit ${after.result.exitCode ?? "none"})`);
  return target.status === "passed" && after.passed;
}

/** Model output can echo or invent credential-shaped text; it is redacted before it prints. */
function show(text: string): void {
  console.log(redactPii(text));
}

/** False when the fixture's patch check failed or the fixture itself is unfit; true otherwise. */
async function run({ fixture, checkout }: LoadedFixture): Promise<boolean> {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${fixture.name}  —  measures: ${fixture.measures}`);
  console.log("=".repeat(72));

  // With a checkout the model sees whole files from the pre-fix source, so its diff can be applied to that source.
  const context = checkout
    ? await Promise.all(checkout.files.map(async (path) => ({ path, excerpt: await readFile(join(checkout.repoDir, path), "utf8") })))
    : fixture.context;
  const rendered = renderIncident(fixture, context);

  const scored = fixture.measures === "fix-quality" && checkout !== undefined;
  if (scored) {
    // Before any model call: a fixture whose evaluator passes on the unfixed source cannot credit any fix.
    const gate = loadConfig();
    const before = await checkReproduces(checkout, { verifyTimeoutSeconds: gate.verifyTimeoutSeconds, patchExcludedPaths: gate.patchExcludedPaths });
    console.log(`\nevaluator before the patch: ${before.result.status} (${before.result.rule}, exit ${before.result.exitCode ?? "none"})`);
    if (!before.reproduces) {
      console.log("FIXTURE UNFIT: the evaluator does not fail before the patch, so the defect does not reproduce. Not run.");
      return false;
    }
  }

  const triage = await askJson<TriageVerdict>(rendered, TRIAGE_SYSTEM, TRIAGE_SCHEMA);
  console.log("\n── TRIAGE ──");
  console.log(`urgent: ${triage.urgent}`);
  show(triage.reasoning);
  if (triage.suspectedCause) show(`suspected cause: ${triage.suspectedCause}`);

  const urgent = triage.urgent === true;

  let patch = "";
  if (urgent) {
    const fix = await askJson<ProposedFix>(rendered, FIX_SYSTEM, FIX_SCHEMA);
    console.log("\n── PROPOSED FIX ──");
    show(`root cause: ${fix.rootCause}`);
    show(`risk: ${fix.risk}`);
    show(fix.patch || "(no patch — the model declined)");
    patch = typeof fix.patch === "string" ? fix.patch : "";
  } else {
    console.log("\n── PROPOSED FIX ──\n(skipped — triage declined to act)");
  }

  let patchOk = true;
  console.log("\n── PATCH CHECK ──");
  if (fixture.measures === "declines-correctly") {
    patchOk = patch.trim() === "";
    console.log(patchOk ? "no patch produced (a decline case)" : "FAIL: a patch was produced for a decline case");
  } else if (!scored) {
    console.log("NOT CHECKED: this fixture has no checkout, so the patch was not run. A printed diff is not a pass.");
  } else if (patch.trim() === "") {
    patchOk = false;
    console.log("FAIL: no patch on a fix case");
  } else {
    patchOk = await checkPatch(checkout!, patch);
    console.log(patchOk ? "PASS: applied as given, target command and evaluator both passed" : "FAIL");
  }

  console.log("\n── GROUND TRUTH ──");
  console.log(`was urgent: ${fixture.groundTruth.wasUrgent}`);
  console.log(fixture.groundTruth.summary);
  if (fixture.groundTruth.reference) {
    console.log(`reference: ${fixture.groundTruth.reference}`);
  }

  const triageCorrect = urgent === fixture.groundTruth.wasUrgent;
  console.log(`\ntriage ${triageCorrect ? "MATCHES" : "DISAGREES WITH"} ground truth`);
  return patchOk;
}

const fixtures = await loadFixtures();
console.log(`Starfish spike — model: ${modelName()}, fixtures: ${fixtures.length}`);
let failures = 0;
for (const loaded of fixtures) {
  // One malformed response must not hide the results of every other fixture.
  try {
    if (!(await run(loaded))) failures += 1;
  } catch (e) {
    failures += 1;
    show(`\n!! ${loaded.fixture.name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failures > 0) process.exitCode = 1;
