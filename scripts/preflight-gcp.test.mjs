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
  "projects describe star-proj --format=value(projectNumber)") [ "$STUB_PROJECT" = "0" ] && exit 1 || echo 424242 ;;
  "projects describe star-proj"*) [ "$STUB_PROJECT" = "0" ] && exit 1 || echo star-proj ;;
  "projects get-iam-policy star-proj"*) [ "$STUB_POLICY_FAIL" = "1" ] && exit 1; printf '%s\\n' "$STUB_POLICY" ;;
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
      STUB_POLICY: "roles/owner,user:me@example.com\nroles/run.builder,serviceAccount:424242-compute@developer.gserviceaccount.com",
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
    // Two runs of the script: about 3 s alone, and past vitest's 5 s when the whole suite runs beside it on a busy machine.
  }, 20_000);

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

  it("fails while the account Cloud Run builds as is Editor or Owner of the project, and says how to fix it (#300)", () => {
    const compute = "424242-compute@developer.gserviceaccount.com";
    expect(run().out).toContain(`ok    the build account ${compute} holds neither roles/editor nor roles/owner on star-proj`);
    for (const role of ["roles/editor", "roles/owner"]) {
      const r = run({ STUB_POLICY: `roles/owner,user:me@example.com\n${role},serviceAccount:${compute}` });
      expect(r.status, role).toBe(1);
      expect(r.out, role).toContain(`FAIL  ${compute}, the account Cloud Run builds images as, holds ${role} on star-proj`);
      expect(r.out, role).toContain("BUILD_SERVICE_ACCOUNT");
    }
    // BUILD_SERVICE_ACCOUNT names the account checked.
    const builder = "builder@star-proj.iam.gserviceaccount.com";
    const named = run({ BUILD_SERVICE_ACCOUNT: builder, STUB_POLICY: `roles/editor,serviceAccount:${compute}\nroles/run.builder,serviceAccount:${builder}` });
    expect(named.status).toBe(0);
    expect(named.out).toContain(`ok    the build account ${builder} holds neither`);
    expect(run({ BUILD_SERVICE_ACCOUNT: builder, STUB_POLICY: `roles/editor,serviceAccount:${builder}` }).status).toBe(1);
    // A policy it cannot read is a warning, never a pass.
    for (const unreadable of [{ STUB_POLICY_FAIL: "1" }, { STUB_POLICY: "" }]) {
      const r = run(unreadable);
      expect(r.out).toContain("warn  could not read");
      expect(r.out).not.toContain("ok    the build account");
    }
  }, 30_000);

  it("only reads: every gcloud call it makes is a describe, list or token request", () => {
    const r = run();
    const verbs = r.calls.filter((c) => c !== "");
    expect(verbs.length).toBeGreaterThan(3);
    for (const call of verbs) {
      expect(call).toMatch(/^(--version|auth |projects describe|projects get-iam-policy|billing projects describe|firestore databases describe|run jobs describe|scheduler jobs describe)/);
      expect(call).not.toMatch(/\b(create|delete|update|enable|add-iam|deploy|execute)\b/);
    }
  });
});
