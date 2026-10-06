// scripts/preflight-gcp.sh talks to gcloud and the Resource Manager API, so these run it against stubs
// of both. They pin what it promises: a blocker is a FAIL and exit 1, a check it could not make is a
// warn and never a pass, and it only ever reads.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./preflight-gcp.sh", import.meta.url).pathname;

const ALL_PERMS = [
  "serviceusage.services.enable",
  "iam.serviceAccounts.create",
  "resourcemanager.projects.setIamPolicy",
  "run.jobs.create",
  "cloudscheduler.jobs.create",
  "secretmanager.secrets.create",
  "cloudbuild.builds.create",
  "artifactregistry.repositories.create",
  "datastore.databases.create",
];

// A gcloud and a curl that answer from STUB_* variables and log every gcloud call they get.
function run(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-stub-"));
  const log = join(dir, "gcloud.log");
  writeFileSync(
    join(dir, "gcloud"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "--version") echo "Google Cloud SDK 999.0.0" ;;
  "auth list"*) echo "$STUB_ACCOUNT" ;;
  "auth application-default print-access-token") [ "$STUB_ADC" = "1" ] && echo tok || exit 1 ;;
  "auth print-access-token") echo tok ;;
  "projects describe star-proj"*) [ "$STUB_PROJECT" = "0" ] && exit 1 || echo star-proj ;;
  "projects describe "*) echo other ;;
  "billing projects describe"*) echo "$STUB_BILLING" ;;
  *) exit 1 ;;
esac
`
  );
  // The curl stub keeps its arguments and its stdin apart, so a test can tell where the token went.
  writeFileSync(join(dir, "curl"), `#!/bin/sh\necho "$*" >> "${join(dir, "curl.args")}"\ncat >> "${join(dir, "curl.stdin")}"\necho "$STUB_PERMS_JSON"\n`);
  chmodSync(join(dir, "gcloud"), 0o755);
  chmodSync(join(dir, "curl"), 0o755);
  const granted = env.STUB_GRANTED ?? ALL_PERMS;
  const r = spawnSync("bash", [script], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      PROJECT_ID: "star-proj",
      STUB_ACCOUNT: "me@example.com",
      STUB_ADC: "1",
      STUB_BILLING: "True",
      STUB_PERMS_JSON: JSON.stringify({ permissions: granted }),
      ...env,
    },
    encoding: "utf8",
  });
  const read = (name) => readFileSync(join(dir, name), { flag: "a+" }).toString();
  return { ...r, out: `${r.stdout}${r.stderr}`, calls: read("gcloud.log").trim().split("\n"), curlArgs: read("curl.args"), curlStdin: read("curl.stdin") };
}

describe("scripts/preflight-gcp.sh", () => {
  it("passes a ready project and says what to run next", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain("ok    gcloud signed in as me@example.com");
    expect(r.out).toContain("ok    billing is enabled on star-proj");
    expect(r.out).toContain("you hold every permission the deploy uses");
    expect(r.out).toContain("this is a first deploy");
    expect(r.out).toContain("No blockers found. Next: scripts/deploy-gcp.sh");
    expect(r.out).not.toContain("FAIL");
  });

  it("needs a project", () => {
    const r = run({ PROJECT_ID: "" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL  PROJECT_ID is not set");
  });

  it("fails when nobody is signed in", () => {
    const r = run({ STUB_ACCOUNT: "" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL  not signed in");
  });

  it("fails when the project cannot be seen", () => {
    const r = run({ STUB_PROJECT: "0" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL  Starfish project star-proj was not found");
  });

  it("fails when billing is off, and only warns when it cannot tell", () => {
    const off = run({ STUB_BILLING: "False" });
    expect(off.status).toBe(1);
    expect(off.out).toContain("FAIL  billing is NOT enabled");
    const unknown = run({ STUB_BILLING: "" });
    expect(unknown.status).toBe(0);
    expect(unknown.out).toContain("warn  could not read billing");
  });

  it("names the permissions it did not see, as a warning and not a verdict", () => {
    const r = run({ STUB_GRANTED: ["run.jobs.create", "iam.serviceAccounts.create"] });
    expect(r.status).toBe(0);
    expect(r.out).toContain("warn  not seen in your permissions on star-proj:");
    expect(r.out).toContain("cloudscheduler.jobs.create");
    expect(r.out).not.toMatch(/not seen[^\n]*run\.jobs\.create/);
  });

  it("does not report permissions as fine when the API gave no answer", () => {
    const r = run({ STUB_PERMS_JSON: '{"error":{"code":403}}' });
    expect(r.out).toContain("warn  could not read your permissions");
    expect(r.out).not.toContain("you hold every permission");
  });

  it("checks the watched and Gemini projects too, when they are different", () => {
    const r = run({ WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "ai-proj" });
    expect(r.out).toContain("ok    Watched project app-proj is reachable");
    expect(r.out).toContain("ok    Gemini project ai-proj is reachable");
  });

  it("refuses the default database, as the deploy does", () => {
    const r = run({ STARFISH_DATABASE_ID: "(default)" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL  STARFISH_DATABASE_ID=(default)");
  });

  it("hands the access token to curl on stdin, never as an argument the process list shows (#145)", () => {
    const r = run();
    expect(r.curlArgs).toContain("-H @-");
    expect(r.curlArgs).not.toContain("tok");
    expect(r.curlStdin).toBe("Authorization: Bearer tok\n");
  });

  it("only reads: every gcloud call it makes is a describe, list or token request", () => {
    const r = run();
    const verbs = r.calls.filter((c) => c !== "");
    expect(verbs.length).toBeGreaterThan(3);
    for (const call of verbs) {
      expect(call).toMatch(/^(--version|auth |projects describe|billing projects describe|firestore databases describe|run jobs describe|scheduler jobs describe)/);
      expect(call).not.toMatch(/\b(create|delete|update|enable|add-iam|deploy|execute)\b/);
    }
  });
});
