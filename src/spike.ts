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
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { askJson, modelName } from "./vertex.js";
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

function renderIncident(f: SpikeFixture): string {
  const { incident, context } = f;
  const ctx = context
    .map((c) => `--- ${c.path} ---\n${c.excerpt}`)
    .join("\n\n");
  return [
    `INCIDENT`,
    JSON.stringify(incident, null, 2),
    ``,
    `SOURCE CONTEXT`,
    ctx,
  ].join("\n");
}

async function loadFixtures(): Promise<SpikeFixture[]> {
  const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".json"));
  return Promise.all(
    files.map(async (f) =>
      JSON.parse(await readFile(join(FIXTURE_DIR, f), "utf8")) as SpikeFixture
    )
  );
}

async function run(fixture: SpikeFixture): Promise<void> {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${fixture.name}  —  measures: ${fixture.measures}`);
  console.log("=".repeat(72));

  const rendered = renderIncident(fixture);

  const triage = await askJson<TriageVerdict>(rendered, TRIAGE_SYSTEM, TRIAGE_SCHEMA);
  console.log("\n── TRIAGE ──");
  console.log(`urgent: ${triage.urgent}`);
  console.log(triage.reasoning);
  if (triage.suspectedCause) console.log(`suspected cause: ${triage.suspectedCause}`);

  const urgent = triage.urgent === true;

  if (urgent) {
    const fix = await askJson<ProposedFix>(rendered, FIX_SYSTEM, FIX_SCHEMA);
    console.log("\n── PROPOSED FIX ──");
    console.log(`root cause: ${fix.rootCause}`);
    console.log(`risk: ${fix.risk}`);
    console.log(fix.patch || "(no patch — the model declined)");
  } else {
    console.log("\n── PROPOSED FIX ──\n(skipped — triage declined to act)");
  }

  console.log("\n── GROUND TRUTH ──");
  console.log(`was urgent: ${fixture.groundTruth.wasUrgent}`);
  console.log(fixture.groundTruth.summary);
  if (fixture.groundTruth.reference) {
    console.log(`reference: ${fixture.groundTruth.reference}`);
  }

  const triageCorrect = urgent === fixture.groundTruth.wasUrgent;
  console.log(`\ntriage ${triageCorrect ? "MATCHES" : "DISAGREES WITH"} ground truth`);
}

const fixtures = await loadFixtures();
console.log(`Starfish spike — model: ${modelName()}, fixtures: ${fixtures.length}`);
let failures = 0;
for (const fixture of fixtures) {
  // One malformed response must not hide the results of every other fixture.
  try {
    await run(fixture);
  } catch (e) {
    failures += 1;
    console.log(`\n!! ${fixture.name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failures > 0) process.exitCode = 1;
