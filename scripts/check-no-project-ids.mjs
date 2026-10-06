#!/usr/bin/env node
/**
 * check-no-project-ids.mjs — no deployment-specific value hardcoded in tracked code (#7).
 * ========================================================================================
 *
 * CLAUDE.md's rule is that nobody edits `src/` to run Starfish against their own project:
 * every deployment-specific value lives in config. `config-boundary-guard.sh` stops a
 * `process.env` read outside `src/config.ts`; it can't see a literal. This looks for the
 * literals that would tie the code to one deployment:
 *
 *   - a hosted domain: <name>.web.app, .firebaseapp.com, .appspot.com, .cloudfunctions.net, .run.app;
 *   - a GCP project id where one is given: `--project <id>`, `projects/<id>/`, `PROJECT_ID=<id>`,
 *     `GOOGLE_CLOUD_PROJECT=<id>`, `projectId: "<id>"`, `project: "<id>"`;
 *   - the name of the organisation that hosts this repository (`hack2skill`).
 *
 * in every tracked file under src/, web/src/ and scripts/ (tests included: a real id in a
 * fixture leaks just the same), except this file and its test. A name passes if it is an example placeholder listed below,
 * a `demo-` project (the Firebase emulator's offline-only prefix), or a shell/template
 * variable. Anything else fails with file:line.
 *
 * What it is not: a proof. A project id written with none of these shapes around it (a bare
 * string, an id split across lines) is not recognised. It catches the recurring mistake of
 * pasting the demo project's id or URL into code, which is the case that matters.
 *
 * Run by `pnpm lint` (so by `pnpm run verify`). Exit 1 on any finding, 0 otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = ["src", "web/src", "scripts"];
/** This check and its test, which hold the shapes it looks for on purpose. */
const SELF = ["scripts/check-no-project-ids.mjs", "scripts/check-no-project-ids.test.mjs"];

/**
 * Names that are placeholders, not deployments: the examples the docs and scripts use, and
 * the fake ids tests build configs with. Add one only when it is obviously not a real project.
 */
export const ALLOWED_NAMES = new Set([
  // Examples in usage text and docs.
  "my-project",
  "my-site",
  // Test fixtures.
  "site",
  "p",
  "h",
  "a",
  "app-proj",
  "elsewhere",
  "home-project",
  "hosted",
  "star-proj",
  "starfish-admin-abc-uc",
  "starfish-home",
  "starfish-proj",
  "store-project",
  "vertex-project",
  "watched-app-1",
]);

/** A GCP project id: 6-30 characters, a lowercase letter first, no trailing hyphen. */
const ID = "[a-z][a-z0-9-]{4,28}[a-z0-9]";
/** A host label (a Hosting site or Cloud Run service may be shorter than a project id). */
const LABEL = "[a-z0-9][a-z0-9-]{0,62}";
/** A hosted domain: the first label is the project, site or service name. */
const DOMAIN = new RegExp(`\\b(${LABEL})\\.(?:web\\.app|firebaseapp\\.com|appspot\\.com|cloudfunctions\\.net|(?:[a-z0-9-]+\\.)*run\\.app)\\b`, "g");
/**
 * A project id given as a value; group 1 is the id. A flag or assignment may be unquoted; a code
 * property must be a quoted string, so `projectId: config.projectId` is code, not an id. A
 * variable (`$PROJECT_ID`, `${id}`, `<project>`) never matches: an id starts with a letter.
 */
const PROJECT = [
  new RegExp(`(?:--project[= ]+|\\bprojects/|\\bPROJECT_ID=|\\bGOOGLE_CLOUD_PROJECT=)["'\`]?(${ID})(?![a-z0-9-])`, "g"),
  new RegExp(`\\b(?:projectId|project):\\s*["'\`](${ID})["'\`]`, "g"),
];
const ORG = /hack2skill/gi;

/** True when `name` is a placeholder rather than a deployment. */
export function isPlaceholder(name) {
  return ALLOWED_NAMES.has(name) || name.startsWith("demo-");
}

/** Every finding in one file's text, as { line, text }. Pure, so it can be tested. */
export function scan(text) {
  const findings = [];
  text.split("\n").forEach((line, i) => {
    const hit = (what) => findings.push({ line: i + 1, text: what });
    for (const m of line.matchAll(DOMAIN)) if (!isPlaceholder(m[1])) hit(`hosted domain "${m[0]}"`);
    for (const re of PROJECT) {
      for (const m of line.matchAll(re)) if (!isPlaceholder(m[1])) hit(`project id "${m[1]}"`);
    }
    for (const m of line.matchAll(ORG)) hit(`organisation name "${m[0]}"`);
  });
  return findings;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && !SELF.includes(f) && !/\.(png|jpe?g|gif|ico|webp|woff2?)$/i.test(f));
  let count = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    for (const f of scan(text)) {
      console.error(`check-no-project-ids: ${file}:${f.line}: ${f.text}`);
      count += 1;
    }
  }
  if (count > 0) {
    console.error(
      `check-no-project-ids: ${count} deployment-specific value(s). Move them to config, or, if one is only an example, add it to ALLOWED_NAMES in scripts/check-no-project-ids.mjs.`
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
