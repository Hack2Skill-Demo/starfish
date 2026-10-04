// scripts/deploy-gcp.sh can't be run against a real project in a test, so these pin what a dry run
// promises: it refuses the unsafe inputs, prints the whole plan, never calls gcloud, and never
// prints the token. The plan is printed with bash's %q, whose escaping differs between bash
// versions, so assertions compare the output with its backslashes removed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./deploy-gcp.sh", import.meta.url).pathname;

// A gcloud that records being called and fails, first on PATH: a dry run must never reach it.
function stubGcloud() {
  const dir = mkdtempSync(join(tmpdir(), "gcloud-stub-"));
  const marker = join(dir, "called");
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(join(dir, "gcloud"), 0o755);
  return { dir, marker };
}

function deploy(env) {
  const stub = stubGcloud();
  const r = spawnSync("bash", [script], {
    env: { PATH: `${stub.dir}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  return { ...r, out: `${r.stdout}${r.stderr}`.replace(/\\/g, ""), gcloudCalled: existsSync(stub.marker) };
}

const dry = { DRY_RUN: "1", PROJECT_ID: "star-proj" };

describe("scripts/deploy-gcp.sh", () => {
  it("needs a project", () => {
    const r = deploy({ DRY_RUN: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("PROJECT_ID is required");
  });

  it("does not pick up the CI workflow's own GITHUB_TOKEN as the secret's value", () => {
    const r = deploy({ ...dry, GITHUB_TOKEN: "ghp_ACTIONS_TOKEN" });
    expect(r.out).not.toContain("secrets versions add");
    expect(r.out).not.toContain("--update-secrets");
  });

  it("refuses the default database: its rules would replace the watched app's", () => {
    const r = deploy({ ...dry, STARFISH_DATABASE_ID: "(default)" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("(default)");
    expect(r.out).not.toContain("firestore deploy");
  });

  it("prints the whole plan and calls neither gcloud nor anything else", () => {
    const r = deploy(dry);
    expect(r.status).toBe(0);
    expect(r.gcloudCalled).toBe(false);
    for (const part of [
      "gcloud services enable",
      "gcloud iam service-accounts create starfish-engine",
      "gcloud iam service-accounts create starfish-scheduler",
      "gcloud firestore databases create --database=starfish",
      "firebase-tools@14 deploy --only firestore",
      "gcloud secrets create starfish-github-token",
      "gcloud run jobs deploy starfish-ingest --source .",
      "gcloud scheduler jobs create http starfish-ingest-tick",
    ]) {
      expect(r.out).toContain(part);
    }
    expect(r.out).toContain("Dry run: nothing was changed.");
  });

  it("scopes each grant to the project it applies to", () => {
    const r = deploy({ ...dry, WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "ai-proj" });
    const engine = "serviceAccount:starfish-engine@star-proj.iam.gserviceaccount.com";
    expect(r.out).toContain(`add-iam-policy-binding app-proj --member=${engine} --role=roles/logging.viewer`);
    // The store role is limited to Starfish's own database, never the whole project.
    const store = r.out.split("\n").find((l) => l.includes("--role=roles/datastore.user")) ?? "";
    expect(store).toContain(`add-iam-policy-binding star-proj --member=${engine}`);
    expect(store).toContain('resource.name == "projects/star-proj/databases/starfish"');
    expect(store).toContain('resource.name.startsWith("projects/star-proj/databases/starfish/")');
    expect(store).not.toContain("--condition=None");
    expect(r.out).toContain(`add-iam-policy-binding ai-proj --member=${engine} --role=roles/aiplatform.user`);
    // Nothing broader than the three roles is granted to the engine.
    expect(r.out).not.toMatch(/roles\/(owner|editor|admin)/i);
  });

  it("lets the scheduler's account start the job and nothing else", () => {
    const r = deploy(dry);
    const scheduler = "serviceAccount:starfish-scheduler@star-proj.iam.gserviceaccount.com";
    expect(r.out).toContain(`run jobs add-iam-policy-binding starfish-ingest`);
    expect(r.out).toContain(`--member=${scheduler} --role=roles/run.invoker`);
    expect(r.out.match(new RegExp(`${scheduler.replace(/[.]/g, "\\.")}`, "g"))).toHaveLength(1);
  });

  it("uses the schedule and settings it is given", () => {
    const r = deploy({
      ...dry,
      SCHEDULE: "*/5 * * * *",
      STARFISH_ENV: "demo",
      EXTRA_ENV_VARS: "STARFISH_SERVICE_PATTERNS=a:b,c:d@STARFISH_LOOKBACK_HOURS=6",
    });
    expect(r.out).toContain("--schedule=*/5 * * * *");
    expect(r.out).toContain("STARFISH_ENV=demo");
    // "@" separates settings, so a comma inside one value survives.
    expect(r.out).toContain("STARFISH_SERVICE_PATTERNS=a:b,c:d@STARFISH_LOOKBACK_HOURS=6");
    expect(r.out).toContain("--update-env-vars=^@^");
  });

  it("mounts the secret only once it has a value, and never prints the value", () => {
    const without = deploy(dry);
    expect(without.out).not.toContain("--update-secrets");
    expect(without.out).toContain("has no version yet");

    const withToken = deploy({ ...dry, STARFISH_GITHUB_TOKEN: "ghp_THIS_MUST_NOT_APPEAR" });
    expect(withToken.out).toContain("--update-secrets=STARFISH_GITHUB_TOKEN=starfish-github-token:latest");
    expect(withToken.out).toContain("gcloud secrets versions add starfish-github-token --data-file=-");
    expect(withToken.out).not.toContain("ghp_THIS_MUST_NOT_APPEAR");
  });

  it("creates a budget alert only when asked, and only with a billing account", () => {
    expect(deploy(dry).out).not.toContain("billing budgets");
    const bad = deploy({ ...dry, BUDGET_USD: "20" });
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain("BILLING_ACCOUNT");
    expect(deploy({ ...dry, BUDGET_USD: "twenty", BILLING_ACCOUNT: "0123AB-456CDE-789FGH" }).status).not.toBe(0);
    const r = deploy({ ...dry, BUDGET_USD: "20", BILLING_ACCOUNT: "0123AB-456CDE-789FGH" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("gcloud billing budgets create --billing-account=0123AB-456CDE-789FGH");
    expect(r.out).toContain("--budget-amount=20USD");
    expect(r.out).toContain("--filter-projects=projects/star-proj");
    // The step says what a budget is: an email, not a ceiling.
    expect(r.out).toContain("does not stop spending");
  });

  it("deploys no rules when asked not to, and runs once when asked to", () => {
    expect(deploy({ ...dry, SKIP_FIRESTORE_RULES: "1" }).out).not.toContain("deploy --only firestore");
    expect(deploy(dry).out).not.toContain("jobs execute");
    expect(deploy({ ...dry, RUN_AFTER_DEPLOY: "1" }).out).toContain("gcloud run jobs execute starfish-ingest");
  });
});
