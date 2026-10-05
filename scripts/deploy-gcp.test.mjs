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

  it("lets the account Cloud Run builds as read the source, before the job is deployed (first-run build denial)", () => {
    const r = deploy(dry);
    const grant = r.out.split("\n").find((l) => l.includes("--role=roles/run.builder")) ?? "";
    expect(grant).toContain("add-iam-policy-binding star-proj");
    expect(grant).toContain("--member=serviceAccount:<project-number>-compute@developer.gserviceaccount.com");
    expect(r.out.indexOf("roles/run.builder")).toBeLessThan(r.out.indexOf("gcloud run jobs deploy starfish-ingest"));
    // Nothing else is granted to that shared account.
    expect(r.out.split("\n").filter((l) => l.includes("compute@developer"))).toHaveLength(1);
  });

  it("grants the build role to the account it is told to build as", () => {
    const r = deploy({ ...dry, BUILD_SERVICE_ACCOUNT: "builder@star-proj.iam.gserviceaccount.com" });
    expect(r.out).toContain("--member=serviceAccount:builder@star-proj.iam.gserviceaccount.com --role=roles/run.builder");
    expect(r.out).not.toContain("compute@developer");
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

  it("keeps the deployed job out of its own ingest, unless told otherwise", () => {
    expect(deploy(dry).out).toContain("STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest");
    expect(deploy({ ...dry, JOB_NAME: "mine" }).out).toContain("STARFISH_EXCLUDED_SERVICES=starfish,mine");
    const own = deploy({ ...dry, EXTRA_ENV_VARS: "STARFISH_EXCLUDED_SERVICES=a,b" });
    expect(own.out).toContain("STARFISH_EXCLUDED_SERVICES=a,b");
    expect(own.out.match(/STARFISH_EXCLUDED_SERVICES=/g)).toHaveLength(1);
  });

  it("deploys no rules when asked not to, and runs once when asked to", () => {
    expect(deploy({ ...dry, SKIP_FIRESTORE_RULES: "1" }).out).not.toContain("deploy --only firestore");
    expect(deploy(dry).out).not.toContain("jobs execute");
    expect(deploy({ ...dry, RUN_AFTER_DEPLOY: "1" }).out).toContain("gcloud run jobs execute starfish-ingest");
  });
});

describe("scripts/deploy-gcp.sh: the agent and its isolated verify job (#74), VERIFY_ISOLATION=cloud-run-job", () => {
  const agent = { ...dry, DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_ISOLATION: "cloud-run-job", VERIFY_COMMAND: "pnpm install --frozen-lockfile && pnpm run verify" };
  const sa = (name) => `serviceAccount:${name}@star-proj.iam.gserviceaccount.com`;
  const line = (out, text) => out.split("\n").find((l) => l.includes(text)) ?? "";
  const grants = (out, member) => out.split("\n").filter((l) => l.includes(`--member=${member}`)).map((l) => l.match(/--role=(\S+)/)?.[1]).sort();

  it("is off unless asked: the default plan has no agent, no verify job and no bucket", () => {
    const r = deploy(dry);
    for (const word of ["starfish-agent", "starfish-verify", "agentCli", "verifyRunnerCli", "storage buckets"]) expect(r.out).not.toContain(word);
  });

  it("needs a repository and a verify command, and refuses what could not work", () => {
    expect(deploy({ ...dry, DEPLOY_AGENT: "1", VERIFY_ISOLATION: "cloud-run-job", VERIFY_COMMAND: "x" }).out).toContain("AGENT_REPO");
    expect(deploy({ ...dry, DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_ISOLATION: "cloud-run-job" }).out).toContain("VERIFY_COMMAND");
    for (const bad of ["shop", "a/b/c", "/shop", "acme/", "acme/../x", "acme/sh op", "acme/shop;rm"]) {
      expect(deploy({ ...agent, AGENT_REPO: bad }).status, bad).not.toBe(0);
    }
    expect(deploy({ ...agent, VERIFY_COMMAND: "a@b" }).out).toContain("'@'");
    for (const t of ["0", "-1", "ten", "3001"]) expect(deploy({ ...agent, VERIFY_TIMEOUT_SECONDS: t }).status, t).not.toBe(0);
    for (const b of ["Has Space", "UPPER", "-lead"]) expect(deploy({ ...agent, VERIFY_BUCKET: b }).status, b).not.toBe(0);
    expect(deploy(agent).status).toBe(0);
  });

  it("creates the verifier's account and grants it NOTHING, on any project or resource", () => {
    const r = deploy(agent);
    expect(r.out).toContain("gcloud iam service-accounts create starfish-verifier");
    expect(r.out).not.toContain(`--member=${sa("starfish-verifier")}`);
    expect(r.out).not.toContain("--member=serviceAccount:starfish-verifier");
  });

  it("deploys the verify job under that account, with no secret and no setting of its own", () => {
    const job = line(deploy(agent).out, "gcloud run jobs deploy starfish-verify");
    expect(job).toContain(`--service-account=starfish-verifier@star-proj.iam.gserviceaccount.com`);
    expect(job).toContain("--args=node,--import,tsx,src/verifyRunnerCli.ts");
    // `--command` would replace the image's entrypoint, which is what starts the runner as root and everything else as `node`.
    expect(job).not.toContain("--command");
    expect(job).toContain("--task-timeout=1200s");
    expect(job).not.toMatch(/--(update|set)-(env-vars|secrets)/);
    expect(job).not.toContain("pnpm install");
  });

  it("gives the verify job's time as the command's limit plus ten minutes, and the agent's as three cycles of it", () => {
    const r = deploy({ ...agent, VERIFY_TIMEOUT_SECONDS: "1200" });
    expect(line(r.out, "gcloud run jobs deploy starfish-verify")).toContain("--task-timeout=1800s");
    expect(line(r.out, "gcloud run jobs deploy starfish-agent")).toContain(`--task-timeout=${3 * (1200 + 300) + 600}s`);
  });

  it("gives the agent exactly what the loop and the isolated verify step need, and the engine's account none of it", () => {
    const r = deploy(agent);
    expect(grants(r.out, sa("starfish-agent"))).toEqual([
      "roles/aiplatform.user",
      "roles/datastore.user",
      "roles/iam.serviceAccountTokenCreator",
      "roles/logging.viewer",
      "roles/run.invoker",
      "roles/secretmanager.secretAccessor",
      "roles/storage.objectAdmin",
    ]);
    // Each narrow grant is on the thing it is for, not on the project.
    expect(line(r.out, "buckets add-iam-policy-binding")).toContain("gs://star-proj-starfish-verify");
    expect(line(r.out, "run jobs add-iam-policy-binding starfish-verify")).toContain(sa("starfish-agent"));
    expect(line(r.out, "roles/iam.serviceAccountTokenCreator")).toContain("service-accounts add-iam-policy-binding starfish-agent@star-proj");
    const store = line(r.out, "roles/datastore.user");
    expect(store).toContain('resource.name == "projects/star-proj/databases/starfish"');
    // The ingest's account keeps its three roles and gains nothing from the agent.
    expect(grants(r.out, sa("starfish-engine"))).toEqual(["roles/aiplatform.user", "roles/datastore.user", "roles/logging.viewer", "roles/secretmanager.secretAccessor"]);
    expect(r.out).not.toMatch(/roles\/(owner|editor|admin)/i);
  });

  it("points the agent at the isolated verify job, and never at running the command in its own process", () => {
    const job = line(deploy(agent).out, "gcloud run jobs deploy starfish-agent");
    expect(job).toContain("STARFISH_VERIFY_ISOLATION=cloud-run-job");
    expect(job).toContain("STARFISH_VERIFY_JOB=starfish-verify");
    expect(job).toContain("STARFISH_VERIFY_BUCKET=star-proj-starfish-verify");
    expect(job).toContain("STARFISH_VERIFY_JOB_REGION=us-central1");
    expect(job).toContain("STARFISH_VERIFY_COMMAND=pnpm install --frozen-lockfile && pnpm run verify");
    expect(job).toContain("STARFISH_GITHUB_REPO=acme/shop");
    expect(job).toContain("STARFISH_DRY_RUN=true");
    expect(job).not.toContain("in-process");
    expect(job).toContain("STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent,starfish-verify");
  });

  it("refuses a setting that would move the verify step: the script owns how it is isolated", () => {
    for (const key of ["STARFISH_VERIFY_ISOLATION=in-process", "STARFISH_VERIFY_JOB=other", "STARFISH_VERIFY_BUCKET=b", "STARFISH_VERIFY_COMMAND=x", "STARFISH_VERIFY_JOB_REGION=r", "STARFISH_VERIFY_TIMEOUT_SECONDS=1"]) {
      const r = deploy({ ...agent, AGENT_EXTRA_ENV_VARS: `STARFISH_LOOKBACK_HOURS=2@${key}` });
      expect(r.status, key).not.toBe(0);
      expect(r.out).toContain("STARFISH_VERIFY_*");
      expect(r.out).not.toContain("gcloud run jobs deploy");
    }
    expect(deploy({ ...agent, AGENT_EXTRA_ENV_VARS: "MY_STARFISH_VERIFY_JOB_NOTE=1" }).status).toBe(0);
  });

  it("makes the bucket private, with a one-day lifecycle", () => {
    const r = deploy(agent);
    expect(line(r.out, "buckets create")).toContain("--uniform-bucket-level-access --public-access-prevention");
    expect(r.out).toContain("--lifecycle-file=<delete objects after 1 day>");
    expect(r.out).not.toContain("allUsers");
  });

  it("starts the agent on its own schedule, with the scheduler allowed to start only the two Starfish jobs", () => {
    const r = deploy({ ...agent, AGENT_SCHEDULE: "*/10 * * * *", AGENT_BASE_BRANCH: "develop", AGENT_EXTRA_ENV_VARS: "STARFISH_MAX_CYCLES_PER_PASS=1" });
    expect(r.out).toContain("gcloud scheduler jobs create http starfish-agent-tick");
    expect(r.out).toContain("--schedule=*/10 * * * *");
    expect(r.out).toContain("STARFISH_GITHUB_BASE_BRANCH=develop");
    expect(r.out).toContain("STARFISH_MAX_CYCLES_PER_PASS=1");
    expect(grants(r.out, sa("starfish-scheduler"))).toEqual(["roles/run.invoker", "roles/run.invoker"]);
  });

  it("lets a person turn the dry run off on purpose, and says so once", () => {
    const r = deploy({ ...agent, AGENT_EXTRA_ENV_VARS: "STARFISH_DRY_RUN=false" });
    expect(r.out.match(/STARFISH_DRY_RUN=/g)).toHaveLength(1);
    expect(r.out).toContain("STARFISH_DRY_RUN=false");
  });

  it("mounts the token on the agent and never on the verify job, and never prints it", () => {
    const r = deploy({ ...agent, STARFISH_GITHUB_TOKEN: "ghp_THIS_MUST_NOT_APPEAR" });
    expect(line(r.out, "gcloud run jobs deploy starfish-agent")).toContain("--update-secrets=STARFISH_GITHUB_TOKEN=starfish-github-token:latest");
    expect(line(r.out, "gcloud run jobs deploy starfish-verify")).not.toContain("--update-secrets");
    expect(r.out).not.toContain("ghp_THIS_MUST_NOT_APPEAR");
  });
});

describe("scripts/deploy-gcp.sh: the agent verified by the target's CI (#74), VERIFY_ISOLATION=github-actions (the default)", () => {
  const agent = { ...dry, DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_CHECKS: "verify" };
  const sa = (name) => `serviceAccount:${name}@star-proj.iam.gserviceaccount.com`;
  const line = (out, text) => out.split("\n").find((l) => l.includes(text)) ?? "";
  const grants = (out, member) => out.split("\n").filter((l) => l.includes(`--member=${member}`)).map((l) => l.match(/--role=(\S+)/)?.[1]).sort();

  it("is the default isolation, and needs the checks that judge, named", () => {
    const none = deploy({ ...dry, DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop" });
    expect(none.status).not.toBe(0);
    expect(none.out).toContain("VERIFY_CHECKS");
    expect(deploy({ ...agent, VERIFY_CHECKS: "a@b" }).out).toContain("'@'");
    expect(deploy({ ...agent, VERIFY_ISOLATION: "in-process" }).out).toContain("github-actions or cloud-run-job");
    expect(deploy(agent).status).toBe(0);
  });

  it("deploys no bucket, no verify job and no verifier account: nothing of the target runs in this project", () => {
    const r = deploy(agent);
    for (const word of ["starfish-verifier", "starfish-verify ", "verifyRunnerCli", "storage buckets", "serviceAccountTokenCreator", "starfish-verify-"]) expect(r.out).not.toContain(word);
    expect(r.out).toContain("gcloud run jobs deploy starfish-agent --source .");
  });

  it("gives the agent only what the loop needs, and nothing for storage, signing or starting another job", () => {
    const r = deploy(agent);
    expect(grants(r.out, sa("starfish-agent"))).toEqual(["roles/aiplatform.user", "roles/datastore.user", "roles/logging.viewer", "roles/secretmanager.secretAccessor"]);
    expect(line(r.out, "roles/datastore.user")).toContain('resource.name == "projects/star-proj/databases/starfish"');
    expect(r.out).not.toMatch(/roles\/(owner|editor|admin)/i);
  });

  it("points the agent at the CI judge, dry run on, with room to wait for CI", () => {
    const job = line(deploy(agent).out, "gcloud run jobs deploy starfish-agent");
    expect(job).toContain("STARFISH_VERIFY_ISOLATION=github-actions");
    expect(job).toContain("STARFISH_VERIFY_CHECKS=verify");
    expect(job).toContain("STARFISH_GITHUB_REPO=acme/shop");
    expect(job).toContain("STARFISH_DRY_RUN=true");
    expect(job).toContain("STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent");
    expect(job).not.toMatch(/STARFISH_VERIFY_(COMMAND|JOB|BUCKET)/);
    expect(job).toContain(`--task-timeout=${3 * (600 + 600) + 600}s`);
  });

  it("takes check names with spaces and slashes, and several of them", () => {
    const job = line(deploy({ ...agent, VERIFY_CHECKS: "ci / test (20), lint" }).out, "gcloud run jobs deploy starfish-agent");
    expect(job).toContain("STARFISH_VERIFY_CHECKS=ci / test (20), lint");
  });

  it("refuses a setting that would move the verify step", () => {
    for (const key of ["STARFISH_VERIFY_ISOLATION=in-process", "STARFISH_VERIFY_CHECKS=x", "STARFISH_VERIFY_COMMAND=x"]) {
      const r = deploy({ ...agent, AGENT_EXTRA_ENV_VARS: key });
      expect(r.status, key).not.toBe(0);
      expect(r.out).toContain("STARFISH_VERIFY_*");
    }
  });

  it("mounts the token on the agent, which needs it to push the branch CI judges, and never prints it", () => {
    const r = deploy({ ...agent, STARFISH_GITHUB_TOKEN: "ghp_THIS_MUST_NOT_APPEAR" });
    expect(line(r.out, "gcloud run jobs deploy starfish-agent")).toContain("--update-secrets=STARFISH_GITHUB_TOKEN=starfish-github-token:latest");
    expect(r.out).not.toContain("ghp_THIS_MUST_NOT_APPEAR");
  });

  it("starts the agent on its own schedule, and the scheduler may start only the two Starfish jobs", () => {
    const r = deploy({ ...agent, AGENT_SCHEDULE: "*/10 * * * *" });
    expect(r.out).toContain("--schedule=*/10 * * * *");
    expect(grants(r.out, sa("starfish-scheduler"))).toEqual(["roles/run.invoker", "roles/run.invoker"]);
  });
});
