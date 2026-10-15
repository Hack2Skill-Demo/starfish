// scripts/deploy-gcp.sh can't be run against a real project in a test, so these pin what a dry run
// promises: it refuses the unsafe inputs, prints the whole plan, never calls gcloud, and never
// prints the token. The plan is printed with bash's %q, whose escaping differs between bash
// versions, so assertions compare the output with its backslashes removed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
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
  it("excludes demo infrastructure only in the demo environment", () => {
    const demo = deploy({ ...dry, STARFISH_ENV: "demo", DEPLOY_AGENT: "1", AGENT_REPO: "owner/repo", VERIFY_CHECKS: "verify" });
    expect(demo.status).toBe(0);
    expect(demo.out).toContain("STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-admin,traffic-*,control-*,stub-*");
    expect(demo.out).toContain("STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent,starfish-admin,traffic-*,control-*,stub-*");
    expect(deploy(dry).out).not.toContain("control-*");
  });

  it("needs a project", () => {
    const r = deploy({ DRY_RUN: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("PROJECT_ID is required");
  });

  describe("DEPLOY_ADMIN_API (#63, #65)", () => {
    const admin = { ...dry, DEPLOY_ADMIN_API: "1", ADMIN_API_ORIGINS: "https://site.web.app" };

    it("deploys nothing of it by default", () => {
      const r = deploy(dry);
      expect(r.out).not.toContain("gcloud run deploy");
      expect(r.out).not.toContain("starfish-admin-api");
      expect(r.out).not.toContain("--allow-unauthenticated");
    });

    it("deploys a public service from the ingest job's image, under its OWN account (#146)", () => {
      const r = deploy(admin);
      expect(r.status).toBe(0);
      const line = r.out.split("\n").find((l) => l.includes("gcloud run deploy starfish-admin")) ?? "";
      expect(line).toContain("--image=<the ingest job's image>");
      expect(line).not.toContain("--source");
      expect(line).toContain("--service-account=starfish-admin-api@star-proj.iam.gserviceaccount.com");
      expect(line).not.toContain("starfish-engine");
      expect(line).not.toContain("--update-secrets");
      expect(line).toContain("--args=node,--import,tsx,src/adminApiCli.ts");
      expect(line).toContain("--allow-unauthenticated");
      expect(line).toContain("--max-instances=2");
      expect(line).toContain("STARFISH_ADMIN_API_ORIGINS=https://site.web.app");
      expect(r.out).toContain("gcloud iam service-accounts create starfish-admin-api");
      expect(deploy({ ...admin, ADMIN_SA_NAME: "ops-admin-api" }).out).toContain("--service-account=ops-admin-api@star-proj.iam.gserviceaccount.com");
    });

    it("gives the admin API's account what one ingest run needs and nothing else: no Gemini, no secret", () => {
      const r = deploy({ ...admin, WATCHED_PROJECT_ID: "app-proj" });
      const member = "--member=serviceAccount:starfish-admin-api@star-proj.iam.gserviceaccount.com";
      const lines = r.out.split("\n").filter((l) => l.includes(member));
      expect(lines.map((l) => l.match(/--role=(\S+)/)?.[1]).sort()).toEqual(["roles/datastore.user", "roles/firebaseauth.viewer", "roles/logging.viewer"]);
      expect(lines.find((l) => l.includes("roles/logging.viewer"))).toContain("add-iam-policy-binding app-proj");
      // Every token is checked for revocation (an Auth lookup): without this role every sign-in gets the one 401.
      expect(lines.find((l) => l.includes("roles/firebaseauth.viewer"))).toContain("add-iam-policy-binding star-proj");
      // No other account gets it.
      expect(r.out.split("\n").filter((l) => l.includes("roles/firebaseauth.viewer") && !l.includes(member))).toEqual([]);
      expect(lines.find((l) => l.includes("roles/datastore.user"))).toContain('resource.name == "projects/star-proj/databases/starfish"');
      // The engine's account gains nothing from it.
      const engine = (out) => out.split("\n").filter((l) => l.includes("--member=serviceAccount:starfish-engine@")).length;
      expect(engine(r.out)).toBe(engine(deploy({ ...dry, WATCHED_PROJECT_ID: "app-proj" }).out));
    });

    describe("run agent now (#276)", () => {
      const both = { ...admin, DEPLOY_AGENT: "1", AGENT_REPO: "o/r", VERIFY_CHECKS: "verify" };
      const service = (out) => out.split("\n").find((l) => l.includes("gcloud run deploy starfish-admin")) ?? "";
      const member = "--member=serviceAccount:starfish-admin-api@star-proj.iam.gserviceaccount.com";
      const startGrants = (out) => out.split("\n").filter((l) => l.includes(member) && l.includes("roles/run.invoker"));

      it("names the agent job to the admin API and lets its account start that one job, when one run deploys both", () => {
        const r = deploy(both);
        expect(r.status).toBe(0);
        expect(service(r.out)).toMatch(/STARFISH_AGENT_JOB=starfish-agent(@|'|"|$)/);
        const grants = startGrants(r.out);
        expect(grants).toHaveLength(1);
        expect(grants[0]).toContain("gcloud run jobs add-iam-policy-binding starfish-agent");
        expect(grants[0]).toContain("--region=us-central1");
        // On the job, never on the project, and never the role that runs a job with overrides.
        expect(r.out.split("\n").filter((l) => l.includes(member) && l.includes("gcloud projects") && l.includes("roles/run."))).toEqual([]);
        expect(r.out.split("\n").filter((l) => l.includes(member) && l.includes("jobsExecutorWithOverrides"))).toEqual([]);
        // The grant comes after the job exists.
        expect(r.out.indexOf("gcloud run jobs deploy starfish-agent")).toBeLessThan(r.out.indexOf(grants[0]));
      });

      it("follows a renamed agent job", () => {
        const r = deploy({ ...both, AGENT_JOB_NAME: "ops-agent" });
        expect(service(r.out)).toContain("STARFISH_AGENT_JOB=ops-agent");
        expect(startGrants(r.out)[0]).toContain("add-iam-policy-binding ops-agent");
      });

      it("sets the name empty and grants nothing on a run that does not deploy the agent, so the route goes away again", () => {
        const r = deploy(admin);
        expect(service(r.out)).toMatch(/STARFISH_AGENT_JOB=(@|'|"|$)/);
        expect(startGrants(r.out)).toEqual([]);
      });

      it("refuses the name from either list: it is set where the grant is made, so the two can't disagree", () => {
        for (const env of [{ EXTRA_ENV_VARS: "STARFISH_AGENT_JOB=elsewhere" }, { AGENT_EXTRA_ENV_VARS: "STARFISH_AGENT_JOB_REGION=europe-west1" }, { EXTRA_ENV_VARS: "STARFISH_MODEL=x@STARFISH_AGENT_JOB=" }]) {
          const r = deploy({ ...both, ...env });
          expect(r.status).toBe(1);
          expect(r.out).toContain("may not set STARFISH_AGENT_JOB");
          expect(r.gcloudCalled).toBe(false);
        }
        // A name that only looks like it is not refused.
        expect(deploy({ ...both, EXTRA_ENV_VARS: "STARFISH_AGENT_JOBS_NOTE=x" }).status).toBe(0);
      });
    });

    describe("the public demo's open actions", () => {
      const service = (out) => out.split("\n").find((l) => l.includes("gcloud run deploy starfish-admin")) ?? "";

      it("are off unless asked, and always set on the admin API so a run without them turns them off", () => {
        expect(service(deploy(admin).out)).toMatch(/STARFISH_PUBLIC_DEMO_ACTIONS=false(@|'|"|$)/);
        const r = deploy({ ...admin, STARFISH_ENV: "demo", PUBLIC_DEMO_ACTIONS: "true" });
        expect(r.status).toBe(0);
        expect(service(r.out)).toMatch(/STARFISH_PUBLIC_DEMO_ACTIONS=true(@|'|"|$)/);
      });

      it("are refused anywhere but the demo, for a value that is not a boolean, and from either list", () => {
        for (const env of [
          { PUBLIC_DEMO_ACTIONS: "true" },
          { STARFISH_ENV: "demo", PUBLIC_DEMO_ACTIONS: "maybe" },
          { STARFISH_ENV: "demo", EXTRA_ENV_VARS: "STARFISH_PUBLIC_DEMO_ACTIONS=true" },
          { STARFISH_ENV: "demo", AGENT_EXTRA_ENV_VARS: "STARFISH_PUBLIC_DEMO_ACTIONS=true" },
        ]) {
          const r = deploy({ ...admin, ...env });
          expect(r.status, JSON.stringify(env)).toBe(1);
          expect(r.gcloudCalled).toBe(false);
        }
      });
    });

    it("keeps the service's own errors out of ingest, in the job and the agent", () => {
      expect(deploy(admin).out).toContain("STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-admin");
      const withAgent = deploy({ ...admin, DEPLOY_AGENT: "1", AGENT_REPO: "o/r", VERIFY_CHECKS: "verify", STARFISH_GITHUB_TOKEN: "x" });
      expect(withAgent.out).toContain("starfish,starfish-ingest,starfish-agent,starfish-admin");
      expect(deploy({ ...admin, ADMIN_SERVICE_NAME: "ops-admin" }).out).toContain("starfish,starfish-ingest,ops-admin");
    });

    it("keeps it out of ingest on a run that does not deploy it too, so a later run cannot undo the exclusion (#177)", () => {
      const jobLine = (out) => out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-ingest")) ?? "";
      expect(jobLine(deploy(dry).out)).toMatch(/STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-admin( |@|$)/);
      expect(jobLine(deploy({ ...dry, ADMIN_SERVICE_NAME: "ops-admin" }).out)).toMatch(/STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,ops-admin( |@|$)/);
      const agentOnly = deploy({ ...dry, DEPLOY_AGENT: "1", AGENT_REPO: "o/r", VERIFY_CHECKS: "verify", STARFISH_GITHUB_TOKEN: "x" });
      expect(agentOnly.out).toContain("STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent,starfish-admin@");
      // The name reaches every job's settings, so it is checked on every run.
      expect(deploy({ ...dry, ADMIN_SERVICE_NAME: "Bad_Name" }).status).not.toBe(0);
    });

    it("warns when an explicit exclusion list leaves the service out, and not when it covers it", () => {
      const missing = deploy({ ...admin, EXTRA_ENV_VARS: "STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest" });
      expect(missing.out).toContain("without starfish-admin");
      expect(deploy({ ...admin, EXTRA_ENV_VARS: "STARFISH_EXCLUDED_SERVICES=starfish,starfish-admin" }).out).not.toContain("without");
      expect(deploy({ ...admin, EXTRA_ENV_VARS: "STARFISH_EXCLUDED_SERVICES=starfish,starfish-*" }).out).not.toContain("without");
    });

    it("refuses a service name or an origin list that is not what it says", () => {
      expect(deploy({ ...admin, ADMIN_SERVICE_NAME: "Bad_Name" }).status).not.toBe(0);
      for (const bad of ["https://a b", "https://a'b", "https://a@b"]) {
        const r = deploy({ ...admin, ADMIN_API_ORIGINS: bad });
        expect(r.status, bad).not.toBe(0);
        expect(r.out).toContain("ADMIN_API_ORIGINS is a comma-separated list");
      }
    });
  });

  it("refuses an env list with an empty entry instead of letting gcloud say \"Invalid flag value []\"", () => {
    for (const bad of ["@STARFISH_X=1", "STARFISH_X=1@", "A=1@@B=2"]) {
      const r = deploy({ ...dry, EXTRA_ENV_VARS: bad });
      expect(r.status, bad).not.toBe(0);
      expect(r.out).toContain("EXTRA_ENV_VARS is a list of NAME=value entries separated by @");
    }
    expect(deploy({ ...dry, AGENT_EXTRA_ENV_VARS: "@B=2" }).out).toContain("AGENT_EXTRA_ENV_VARS is a list");
    const ok = deploy({ ...dry, EXTRA_ENV_VARS: "STARFISH_EXCLUDED_SERVICES=starfish,control-*@STARFISH_X=1" });
    expect(ok.status).toBe(0);
    expect(ok.out).toContain("STARFISH_EXCLUDED_SERVICES=starfish,control-*@STARFISH_X=1");
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

  it("deploys the rules and indexes to the configured database, not the one firebase.json names (#148)", () => {
    const r = deploy({ ...dry, STARFISH_DATABASE_ID: "ops-store" });
    expect(r.status).toBe(0);
    expect(r.out).toContain('(write .firebase-deploy.json: firebase.json with "database": "ops-store")');
    expect(r.out).toContain("firebase-tools@14.27.0 deploy --only firestore --project star-proj --config .firebase-deploy.json");
    expect(r.out).toContain("gcloud firestore databases create --database=ops-store");
    expect(r.out).toContain('resource.name == "projects/star-proj/databases/ops-store"');
    // The default goes through the same copy, so there is one path.
    expect(deploy(dry).out).toContain('"database": "starfish"');
    for (const bad of ["Ops", "abc", "1abc", "abc-", "a_bc", 'ab"c', "a".repeat(64)]) {
      const b = deploy({ ...dry, STARFISH_DATABASE_ID: bad });
      expect(b.status, bad).not.toBe(0);
      expect(b.out, bad).toContain("STARFISH_DATABASE_ID must");
    }
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
      "firebase-tools@14.27.0 deploy --only firestore",
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
    // Nothing broader than the two roles is granted to the engine, and no Gemini role at all (#308): ingest makes no model call.
    expect(r.out).not.toContain(`--member=${engine} --role=roles/aiplatform.user`);
    expect(r.out).not.toMatch(/roles\/(owner|editor|admin)/i);
  });

  it("takes back the Gemini role an earlier deploy gave the engine, before the agent's own grant (#308)", () => {
    const r = deploy({ ...dry, VERTEX_PROJECT_ID: "ai-proj", DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_CHECKS: "verify" });
    expect(r.status).toBe(0);
    const remove = "(if an earlier deploy granted it) gcloud projects remove-iam-policy-binding ai-proj: roles/aiplatform.user of starfish-engine@star-proj.iam.gserviceaccount.com";
    expect(r.out).toContain(remove);
    // The agent still calls Gemini: its grant comes after the removal, so an account shared by name would keep it.
    const agentGrant = "add-iam-policy-binding ai-proj --member=serviceAccount:starfish-agent@star-proj.iam.gserviceaccount.com --role=roles/aiplatform.user";
    expect(r.out).toContain(agentGrant);
    expect(r.out.indexOf(remove)).toBeLessThan(r.out.indexOf(agentGrant));
    // Without the agent nothing in the plan grants Gemini to anyone.
    expect(deploy(dry).out).not.toMatch(/add-iam-policy-binding \S+ --member=\S+ --role=roles\/aiplatform\.user/);
  });

  it("refuses a schedule that is not a five-field cron, before anything changes (#308)", () => {
    for (const [name, bad] of [["SCHEDULE", "hourly"], ["SCHEDULE", "*/5 * * *"], ["SCHEDULE", "0 * * * * *"], ["SCHEDULE", "0 * * * *@X=1"],
      ["SCHEDULE", "$(id) * * * *"], ["AGENT_SCHEDULE", "30 * * *"], ["AGENT_SCHEDULE", "30 * * * mon;id"]]) {
      const r = deploy({ ...dry, [name]: bad });
      expect(r.status, `${name}=${bad}`).not.toBe(0);
      expect(r.out, `${name}=${bad}`).toContain(`${name} must be a five-field cron`);
      expect(r.out, `${name}=${bad}`).not.toContain("gcloud services enable");
    }
    // Day and month names, which Cloud Scheduler accepts, pass too; the UI then just shows no next-run estimate.
    for (const good of ["*/5 * * * *", "0 9-17 * * 1-5", "15,45 * * * *", "30 * * * MON-FRI", "0 9 1 JAN *"]) {
      expect(deploy({ ...dry, SCHEDULE: good, AGENT_SCHEDULE: good }).status, good).toBe(0);
    }
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
    // The job is told its own schedule, so the UI can say when the next run is expected (#38).
    expect(r.out).toContain("@STARFISH_INGEST_SCHEDULE=*/5 * * * *");
    // "@" separates settings, so a comma inside one value survives.
    expect(r.out).toContain("STARFISH_SERVICE_PATTERNS=a:b,c:d@STARFISH_LOOKBACK_HOURS=6");
    expect(r.out).toContain("--update-env-vars=^@^");
  });

  it("stores the token without printing it, and neither mounts it on the ingest job nor lets the engine read it (#146)", () => {
    const withToken = deploy({ ...dry, STARFISH_GITHUB_TOKEN: "ghp_THIS_MUST_NOT_APPEAR" });
    expect(withToken.out).toContain("gcloud secrets versions add starfish-github-token --data-file=-");
    expect(withToken.out).not.toContain("ghp_THIS_MUST_NOT_APPEAR");
    expect(withToken.out).not.toContain("--update-secrets");
    expect(withToken.out).not.toContain("secrets add-iam-policy-binding");
    // What an earlier version granted and mounted is taken back.
    const ingest = withToken.out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-ingest")) ?? "";
    expect(ingest).toContain("--remove-secrets=STARFISH_GITHUB_TOKEN");
    expect(withToken.out).toContain("remove-iam-policy-binding starfish-github-token: secretAccessor of starfish-engine@star-proj.iam.gserviceaccount.com");
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

  // #262: after the rules and indexes, it says an index takes minutes to build and how to backfill the guests' copies;
  // it prints the backfill and never runs it.
  it("after the rules, prints the guests' copies backfill and that an index takes minutes, and runs neither", () => {
    const r = deploy(dry);
    const after = r.out.slice(r.out.indexOf("deploy --only firestore"));
    expect(after).toContain("a new index can take minutes to build");
    expect(after).toContain("pnpm public-view -- --apply --project=star-proj");
    expect(after).toContain("STARFISH_DATABASE_ID=starfish");
    expect(r.out).not.toMatch(/^\+ .*public-view/m);
    expect(deploy({ ...dry, SKIP_FIRESTORE_RULES: "1" }).out).not.toContain("public-view");
  });

  describe("the switches that let Starfish act on its own (#174)", () => {
    // --update-env-vars keeps a name it is not given: a switch taken out of a list must be set back to off, not left on.
    const switches = {
      STARFISH_AUTO_MERGE: "false",
      STARFISH_AUTO_MERGE_TARGETS: "",
      STARFISH_PHONE_ESCALATION: "false",
      STARFISH_INDEX_AUTO_APPLY: "false",
      STARFISH_INDEX_ALLOWED_TARGETS: "",
      STARFISH_REVIEW_REQUIRED: "true",
    };
    const agentEnv = { DEPLOY_AGENT: "1", AGENT_REPO: "o/r", VERIFY_CHECKS: "verify", STARFISH_GITHUB_TOKEN: "x" };
    const adminEnv = { DEPLOY_ADMIN_API: "1" };
    // The "@"-separated settings of one deployed job or service: each name's value, and how many times it is set.
    const settings = (out, command) => {
      const l = out.split("\n").find((x) => x.includes(command)) ?? "";
      const list = /--update-env-vars=\^@\^(.*?)(?= --[a-z]|$)/.exec(l)?.[1] ?? "";
      const values = {};
      const counts = {};
      for (const entry of list.split("@")) {
        const name = entry.slice(0, entry.indexOf("="));
        values[name] = entry.slice(entry.indexOf("=") + 1);
        counts[name] = (counts[name] ?? 0) + 1;
      }
      return { values, counts };
    };
    const jobs = ["gcloud run jobs deploy starfish-ingest", "gcloud run jobs deploy starfish-agent", "gcloud run deploy starfish-admin"];

    it("sets each one to the engine's default, off, on every job it deploys, when no list sets it", () => {
      const r = deploy({ ...dry, ...agentEnv, ...adminEnv });
      expect(r.status).toBe(0);
      for (const job of jobs) {
        const { values } = settings(r.out, job);
        for (const [name, value] of Object.entries(switches)) expect(values[name], `${job}: ${name}`).toBe(value);
      }
      expect(settings(r.out, jobs[1]).values.STARFISH_DRY_RUN).toBe("true");
    });

    it("leaves a switch a list sets to that list, set once, and still defaults the others", () => {
      const r = deploy({
        ...dry, ...agentEnv, ...adminEnv,
        EXTRA_ENV_VARS: "STARFISH_INDEX_AUTO_APPLY=true",
        INDEX_TARGETS: "app-proj/(default)",
        AGENT_EXTRA_ENV_VARS: "STARFISH_AUTO_MERGE=true@STARFISH_AUTO_MERGE_TARGETS=o/r@STARFISH_PHONE_ESCALATION=true",
      });
      expect(r.status).toBe(0);
      const agent = settings(r.out, jobs[1]);
      for (const name of Object.keys(switches)) expect(agent.counts[name], name).toBe(1);
      expect(agent.values.STARFISH_AUTO_MERGE).toBe("true");
      expect(agent.values.STARFISH_AUTO_MERGE_TARGETS).toBe("o/r");
      expect(agent.values.STARFISH_PHONE_ESCALATION).toBe("true");
      expect(agent.values.STARFISH_INDEX_AUTO_APPLY).toBe("true");
      expect(agent.values.STARFISH_INDEX_ALLOWED_TARGETS).toBe("app-proj/(default)");
      expect(agent.values.STARFISH_REVIEW_REQUIRED).toBe("true");
      // AGENT_EXTRA_ENV_VARS reaches the agent alone: the ingest job and the admin API keep auto-merge and phoning off.
      for (const job of [jobs[0], jobs[2]]) {
        const { values, counts } = settings(r.out, job);
        expect(values.STARFISH_AUTO_MERGE, job).toBe("false");
        expect(values.STARFISH_PHONE_ESCALATION, job).toBe("false");
        expect(values.STARFISH_INDEX_AUTO_APPLY, job).toBe("true");
        expect(counts.STARFISH_INDEX_AUTO_APPLY, job).toBe(1);
      }
    });

    it("turns a switch off again on the next deploy once it is taken out of the list", () => {
      const on = deploy({ ...dry, ...agentEnv, AGENT_EXTRA_ENV_VARS: "STARFISH_AUTO_MERGE=true@STARFISH_AUTO_MERGE_TARGETS=o/r" });
      expect(settings(on.out, jobs[1]).values.STARFISH_AUTO_MERGE).toBe("true");
      const off = deploy({ ...dry, ...agentEnv, AGENT_EXTRA_ENV_VARS: "STARFISH_MAX_CYCLES_PER_PASS=1" });
      expect(settings(off.out, jobs[1]).values.STARFISH_AUTO_MERGE).toBe("false");
      expect(settings(off.out, jobs[1]).values.STARFISH_AUTO_MERGE_TARGETS).toBe("");
    });

    it("says so in its header", () => {
      const header = readFileSync(script, "utf8").split("\nset -euo pipefail")[0];
      for (const name of Object.keys(switches)) expect(header).toContain(name);
      expect(header).toContain("--update-env-vars, which keeps a name it is not given");
    });
  });

  describe("VERTEX_LOCATION: where Gemini is called, apart from the jobs' region", () => {
    const agent = { DEPLOY_AGENT: "1", AGENT_REPO: "o/r", VERIFY_CHECKS: "verify" };
    const line = (out, job) => out.split("\n").find((l) => l.includes(job)) ?? "";

    it("sets STARFISH_VERTEX_LOCATION on every job, and keeps the jobs in REGION", () => {
      const r = deploy({ ...dry, ...agent, DEPLOY_ADMIN_API: "1", VERTEX_LOCATION: "global" });
      expect(r.status).toBe(0);
      for (const job of ["gcloud run jobs deploy starfish-ingest", "gcloud run jobs deploy starfish-agent", "gcloud run deploy starfish-admin"]) {
        expect(line(r.out, job), job).toContain("@STARFISH_VERTEX_LOCATION=global");
        expect(line(r.out, job), job).toContain("@GOOGLE_CLOUD_LOCATION=us-central1");
      }
    });

    it("sets it empty by default, so clearing it restores the engine's default", () => {
      const r = deploy({ ...dry, ...agent });
      expect(line(r.out, "gcloud run jobs deploy starfish-agent")).toContain("@STARFISH_VERTEX_LOCATION=@");
    });

    it.each([["a location that is not one", { VERTEX_LOCATION: "us-central1.evil.example" }], ["an extra list setting it", { EXTRA_ENV_VARS: "STARFISH_VERTEX_LOCATION=global" }]])(
      "refuses %s",
      (_name, over) => {
        const r = deploy({ ...dry, ...agent, ...over });
        expect(r.status).not.toBe(0);
        expect(r.gcloudCalled).toBe(false);
      }
    );
  });

  describe("INDEX_TARGETS: the missing-index repair's databases, and only the grants it needs there (#11)", () => {
    const agent = { DEPLOY_AGENT: "1", AGENT_REPO: "o/r", VERIFY_CHECKS: "verify" };
    const grants = (out) => out.split("\n").filter((l) => /--role=roles\/datastore\.(indexAdmin|viewer)/.test(l));

    it("grants nothing and wires no target by default", () => {
      const r = deploy({ ...dry, ...agent });
      expect(grants(r.out)).toEqual([]);
      expect(r.out).toContain("@STARFISH_INDEX_ALLOWED_TARGETS=@");
    });

    it("grants the agent indexAdmin and viewer on each target, conditioned to that database, and lists it for the engine", () => {
      const r = deploy({ ...dry, ...agent, WATCHED_PROJECT_ID: "app-proj", INDEX_TARGETS: "app-proj/(default),app-proj/analytics" });
      expect(r.status).toBe(0);
      const g = grants(r.out);
      expect(g).toHaveLength(4);
      for (const l of g) {
        expect(l).toContain("add-iam-policy-binding app-proj --member=serviceAccount:starfish-agent@star-proj.iam.gserviceaccount.com");
        expect(l).toMatch(/--condition=expression=resource\.name == "projects\/app-proj\/databases\/(\(default\)|analytics)" \|\| resource\.name\.startsWith\("projects\/app-proj\/databases\/(\(default\)|analytics)\/"\)/);
      }
      const agentLine = r.out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-agent")) ?? "";
      expect(agentLine).toContain("@STARFISH_INDEX_ALLOWED_TARGETS=app-proj/(default),app-proj/analytics");
      // The ingest job never repairs anything.
      const ingest = r.out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-ingest")) ?? "";
      expect(ingest).toContain("@STARFISH_INDEX_ALLOWED_TARGETS=@");
    });

    it.each([
      ["Starfish's own database", { ...agent, INDEX_TARGETS: "star-proj/starfish" }],
      ["an entry that is not project/database", { ...agent, INDEX_TARGETS: "app-proj" }],
      ["a condition-breaking name", { ...agent, INDEX_TARGETS: 'app-proj/x")||true' }],
      ["targets without the agent", { INDEX_TARGETS: "app-proj/(default)" }],
      ["an extra list naming targets", { ...agent, AGENT_EXTRA_ENV_VARS: "STARFISH_INDEX_ALLOWED_TARGETS=app-proj/(default)" }],
    ])("refuses %s", (_name, over) => {
      const r = deploy({ ...dry, ...over });
      expect(r.status).not.toBe(0);
      expect(r.gcloudCalled).toBe(false);
    });
  });

  describe("STARFISH_MONITORING_ENABLED (#19)", () => {
    const watched = { ...dry, WATCHED_PROJECT_ID: "app-proj" };
    const jobLine = (out) => out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-ingest")) ?? "";

    it("grants no Monitoring role and turns the signal off by default", () => {
      const r = deploy(watched);
      expect(r.status).toBe(0);
      expect(r.out).not.toContain("roles/monitoring.viewer");
      expect(r.out).not.toContain("monitoring.googleapis.com");
      // Always set, so a redeploy with it off turns off a job deployed with it on.
      expect(jobLine(r.out)).toContain("@STARFISH_MONITORING_ENABLED=false");
    });

    it("with true, grants roles/monitoring.viewer on the WATCHED project to the engine's account, and turns it on", () => {
      const r = deploy({ ...watched, STARFISH_MONITORING_ENABLED: "true" });
      expect(r.status).toBe(0);
      expect(r.gcloudCalled).toBe(false);
      const grants = r.out.split("\n").filter((l) => l.includes("--role=roles/monitoring.viewer"));
      expect(grants).toEqual([
        expect.stringContaining("add-iam-policy-binding app-proj --member=serviceAccount:starfish-engine@star-proj.iam.gserviceaccount.com"),
      ]);
      expect(grants[0]).toContain("--condition=None");
      expect(r.out).toContain("gcloud services enable monitoring.googleapis.com --project=app-proj");
      expect(jobLine(r.out)).toContain("@STARFISH_MONITORING_ENABLED=true");
    });

    it("gives the admin API's account the role too, since it runs the same ingest; the agent gets none", () => {
      const r = deploy({
        ...watched,
        STARFISH_MONITORING_ENABLED: "true",
        DEPLOY_ADMIN_API: "1",
        DEPLOY_AGENT: "1",
        AGENT_REPO: "o/r",
        VERIFY_CHECKS: "verify",
        STARFISH_GITHUB_TOKEN: "x",
      });
      expect(r.status).toBe(0);
      const members = r.out
        .split("\n")
        .filter((l) => l.includes("--role=roles/monitoring.viewer"))
        .map((l) => l.match(/--member=serviceAccount:([^@]+)@/)?.[1]);
      expect(members.sort()).toEqual(["starfish-admin-api", "starfish-engine"]);
      const admin = r.out.split("\n").find((l) => l.includes("gcloud run deploy starfish-admin")) ?? "";
      expect(admin).toContain("STARFISH_MONITORING_ENABLED=true");
    });

    it("refuses another value, and refuses the setting through the extra lists, which would skip the role", () => {
      // The engine's own spellings mean the same here.
      expect(jobLine(deploy({ ...dry, STARFISH_MONITORING_ENABLED: "1" }).out)).toContain("@STARFISH_MONITORING_ENABLED=true");
      expect(jobLine(deploy({ ...dry, STARFISH_MONITORING_ENABLED: "No" }).out)).toContain("@STARFISH_MONITORING_ENABLED=false");
      const bad = deploy({ ...dry, STARFISH_MONITORING_ENABLED: "on" });
      expect(bad.status).not.toBe(0);
      expect(bad.out).toContain("STARFISH_MONITORING_ENABLED must be true or false");
      for (const list of ["EXTRA_ENV_VARS", "AGENT_EXTRA_ENV_VARS"]) {
        const r = deploy({ ...dry, [list]: "STARFISH_LOOKBACK_HOURS=6@STARFISH_MONITORING_ENABLED=true" });
        expect(r.status).not.toBe(0);
        expect(r.out).toContain(`${list} may not set STARFISH_MONITORING_ENABLED`);
        expect(r.out).not.toContain("gcloud run jobs deploy");
      }
      // The resource types stay an ordinary extra setting.
      expect(deploy({ ...dry, EXTRA_ENV_VARS: "STARFISH_MONITORING_RESOURCE_TYPES=cloud_function" }).status).toBe(0);
    });
  });

  describe("the ingest run budget and the timeouts above it (#221)", () => {
    const admin = { ...dry, DEPLOY_ADMIN_API: "1", ADMIN_API_ORIGINS: "https://site.web.app" };
    const lineOf = (out, text) => out.split("\n").find((l) => l.includes(text)) ?? "";
    const seconds = (line, flag) => Number(line.match(new RegExp(`${flag}=(\\d+)s?(?:\\s|$)`))?.[1]);
    const budgetOf = (line) => Number(line.match(/@STARFISH_INGEST_RUN_BUDGET_SECONDS=(\d+)/)?.[1]);

    it.each([[undefined], ["480"], ["900"], ["3480"]])("budget %s: the job's task timeout and the admin API's timeout both exceed it", (budget) => {
      const r = deploy({ ...admin, ...(budget !== undefined && { INGEST_RUN_BUDGET_SECONDS: budget }) });
      expect(r.status).toBe(0);
      const job = lineOf(r.out, "gcloud run jobs deploy starfish-ingest");
      const service = lineOf(r.out, "gcloud run deploy starfish-admin");
      const runBudget = budgetOf(job);
      expect(runBudget).toBe(Number(budget ?? 480));
      // The ingest job and the admin API run the same ingest with the same budget.
      expect(budgetOf(service)).toBe(runBudget);
      // Two minutes over it at least: to start, read the state and record a given-up window as a failed last_run.
      expect(seconds(job, "--task-timeout")).toBe(runBudget + 120);
      expect(seconds(service, "--timeout")).toBeGreaterThanOrEqual(runBudget + 120);
      expect(seconds(service, "--timeout")).toBeLessThanOrEqual(3600);
    });

    it("keeps today's timeouts by default: 600 s for the job, 900 s for the admin API", () => {
      const r = deploy(admin);
      expect(lineOf(r.out, "gcloud run jobs deploy starfish-ingest")).toContain("--task-timeout=600s");
      expect(lineOf(r.out, "gcloud run deploy starfish-admin")).toContain("--timeout=900");
    });

    it("refuses a budget that is not a whole number above zero, one no request could hold, and the setting through the extra lists", () => {
      for (const bad of ["0", "-5", "8m", "007", "3481"]) {
        const r = deploy({ ...dry, INGEST_RUN_BUDGET_SECONDS: bad });
        expect(r.status, bad).not.toBe(0);
        expect(r.out).toContain("INGEST_RUN_BUDGET_SECONDS");
        expect(r.out).not.toContain("gcloud run jobs deploy");
      }
      for (const list of ["EXTRA_ENV_VARS", "AGENT_EXTRA_ENV_VARS"]) {
        const r = deploy({ ...dry, [list]: "STARFISH_LOOKBACK_HOURS=6@STARFISH_INGEST_RUN_BUDGET_SECONDS=5000" });
        expect(r.status).not.toBe(0);
        expect(r.out).toContain(`${list} may not set STARFISH_INGEST_RUN_BUDGET_SECONDS`);
      }
    });
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
      "roles/run.jobsExecutorWithOverrides",
      "roles/secretmanager.secretAccessor",
      "roles/storage.objectAdmin",
    ]);
    // Each narrow grant is on the thing it is for, not on the project.
    expect(line(r.out, "buckets add-iam-policy-binding")).toContain("gs://star-proj-starfish-verify");
    // Starting the job with the request as a container override takes run.jobs.runWithOverrides, which run.invoker lacks (#149).
    expect(line(r.out, "run jobs add-iam-policy-binding starfish-verify")).toContain(sa("starfish-agent"));
    expect(line(r.out, "run jobs add-iam-policy-binding starfish-verify")).toContain("--role=roles/run.jobsExecutorWithOverrides");
    expect(line(r.out, "roles/iam.serviceAccountTokenCreator")).toContain("service-accounts add-iam-policy-binding starfish-agent@star-proj");
    const store = line(r.out, "roles/datastore.user");
    expect(store).toContain('resource.name == "projects/star-proj/databases/starfish"');
    // The ingest's account keeps its two roles (no Gemini, #308) and gains nothing from the agent, not even the token (#146).
    expect(grants(r.out, sa("starfish-engine"))).toEqual(["roles/datastore.user", "roles/logging.viewer"]);
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
    expect(job).toContain("STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent,starfish-admin,starfish-verify");
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

  it("refuses the same through EXTRA_ENV_VARS, which the agent job gets too (#147)", () => {
    for (const key of ["STARFISH_VERIFY_ISOLATION=in-process", "STARFISH_VERIFY_JOB=other", "STARFISH_VERIFY_COMMAND=x", "STARFISH_VERIFY_REQUEST=x"]) {
      const r = deploy({ ...agent, EXTRA_ENV_VARS: `STARFISH_LOOKBACK_HOURS=2@${key}` });
      expect(r.status, key).not.toBe(0);
      expect(r.out).toContain("EXTRA_ENV_VARS may not set STARFISH_VERIFY_*");
      expect(r.out).not.toContain("gcloud ");
    }
    // The issue's reproduction: both overrides at once.
    const r = deploy({ ...agent, EXTRA_ENV_VARS: "STARFISH_VERIFY_ISOLATION=in-process@STARFISH_DRY_RUN=false" });
    expect(r.status).not.toBe(0);
    // Without the agent, the ingest job ignores them, so nothing is refused.
    expect(deploy({ ...dry, EXTRA_ENV_VARS: "STARFISH_VERIFY_ISOLATION=in-process" }).status).toBe(0);
  });

  it("turns the dry run off only through AGENT_EXTRA_ENV_VARS, never through EXTRA_ENV_VARS (#147)", () => {
    const r = deploy({ ...agent, EXTRA_ENV_VARS: "STARFISH_DRY_RUN=false" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("set it in AGENT_EXTRA_ENV_VARS");
    expect(r.out).not.toContain("gcloud ");
  });

  it("puts its own safety values after the extra settings, and refuses a name set twice before changing anything (#147)", () => {
    const job = line(deploy({ ...agent, EXTRA_ENV_VARS: "STARFISH_LOOKBACK_HOURS=2", AGENT_EXTRA_ENV_VARS: "STARFISH_MAX_CYCLES_PER_PASS=1" }).out, "gcloud run jobs deploy starfish-agent");
    const env = job.slice(job.indexOf("--update-env-vars="));
    expect(env.indexOf("STARFISH_MAX_CYCLES_PER_PASS=1")).toBeLessThan(env.indexOf("STARFISH_VERIFY_ISOLATION=cloud-run-job"));
    expect(env.indexOf("STARFISH_VERIFY_ISOLATION=cloud-run-job")).toBeLessThan(env.indexOf("STARFISH_DRY_RUN=true"));
    for (const [extra, agentExtra, name] of [
      ["STARFISH_LOOKBACK_HOURS=2", "STARFISH_LOOKBACK_HOURS=6", "STARFISH_LOOKBACK_HOURS"],
      ["", "STARFISH_DATABASE_ID=other", "STARFISH_DATABASE_ID"],
      ["", "STARFISH_DRY_RUN=false@STARFISH_DRY_RUN=true", "STARFISH_DRY_RUN"],
      ["GOOGLE_CLOUD_PROJECT=elsewhere", "", "GOOGLE_CLOUD_PROJECT"],
    ]) {
      const r = deploy({ ...agent, EXTRA_ENV_VARS: extra, AGENT_EXTRA_ENV_VARS: agentExtra });
      expect(r.status, name).not.toBe(0);
      expect(r.out, name).toContain(`${name} is set twice`);
      expect(r.out, name).not.toContain("== APIs");
    }
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
    // The agent job is told its own schedule, so the UI can say when the next pass is expected (#274); the ingest job is not.
    expect(line(r.out, "gcloud run jobs deploy starfish-agent")).toContain("@STARFISH_AGENT_SCHEDULE=*/10 * * * *");
    expect(line(r.out, "gcloud run jobs deploy starfish-ingest")).toContain("STARFISH_INGEST_SCHEDULE=");
    expect(line(r.out, "gcloud run jobs deploy starfish-ingest")).not.toContain("STARFISH_AGENT_SCHEDULE");
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

describe("scripts/deploy-gcp.sh: Twilio's credentials for the phone escalation (#37)", () => {
  const both = { ...dry, DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_CHECKS: "verify", STARFISH_GITHUB_TOKEN: "ghp_x", DEPLOY_ADMIN_API: "1" };
  const SID = `AC${"0".repeat(31)}9`;
  const TOKEN = `${"a".repeat(31)}b`;
  const FROM = "+15550001111";
  const twilio = { STARFISH_TWILIO_ACCOUNT_SID: SID, STARFISH_TWILIO_AUTH_TOKEN: TOKEN, STARFISH_TWILIO_FROM_NUMBER: FROM };
  const SECRETS = "STARFISH_TWILIO_ACCOUNT_SID=starfish-twilio-account-sid:latest,STARFISH_TWILIO_AUTH_TOKEN=starfish-twilio-auth-token:latest,STARFISH_TWILIO_FROM_NUMBER=starfish-twilio-from-number:latest";

  it("creates and mounts nothing for Twilio when no credentials are given", () => {
    const r = deploy(both);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("twilio");
    expect(r.out).not.toContain("TWILIO");
  });

  it("stores each value in its own secret over stdin, never printed, readable by the agent's and the admin API's accounts only", () => {
    const r = deploy({ ...both, ...twilio });
    expect(r.status).toBe(0);
    for (const v of [SID, TOKEN]) expect(r.out).not.toContain(v);
    for (const [name, secret] of [["STARFISH_TWILIO_ACCOUNT_SID", "starfish-twilio-account-sid"], ["STARFISH_TWILIO_AUTH_TOKEN", "starfish-twilio-auth-token"], ["STARFISH_TWILIO_FROM_NUMBER", "starfish-twilio-from-number"]]) {
      expect(r.out).toContain(`gcloud secrets create ${secret}`);
      expect(r.out).toContain(`<${name}> | gcloud secrets versions add ${secret} --data-file=-`);
      const members = r.out.split("\n").filter((l) => l.includes(`add-iam-policy-binding ${secret}`)).map((l) => /--member=serviceAccount:([^ ]+)/.exec(l)?.[1]);
      expect(members.sort()).toEqual(["starfish-admin-api@star-proj.iam.gserviceaccount.com", "starfish-agent@star-proj.iam.gserviceaccount.com"]);
    }
  });

  it("mounts them on the agent job (in its one secrets flag) and the admin API, never on the ingest", () => {
    const r = deploy({ ...both, ...twilio });
    const lines = r.out.split("\n");
    const agentDeploy = lines.find((l) => l.includes("gcloud run jobs deploy starfish-agent")) ?? "";
    const adminDeploy = lines.find((l) => l.includes("gcloud run deploy starfish-admin")) ?? "";
    const ingestDeploy = lines.find((l) => l.includes("gcloud run jobs deploy starfish-ingest")) ?? "";
    expect(agentDeploy).toContain(`--update-secrets=STARFISH_GITHUB_TOKEN=starfish-github-token:latest,${SECRETS}`);
    expect(agentDeploy.match(/--update-secrets/g)).toHaveLength(1);
    expect(adminDeploy).toContain(`--update-secrets=${SECRETS}`);
    expect(ingestDeploy).not.toContain("TWILIO");
  });

  it("refuses a partial set, or a value of the wrong shape, by name and without echoing it", () => {
    const partial = deploy({ ...both, STARFISH_TWILIO_ACCOUNT_SID: SID });
    expect(partial.status).not.toBe(0);
    expect(partial.out).toContain("must be set together");
    const bad = deploy({ ...both, ...twilio, STARFISH_TWILIO_AUTH_TOKEN: "notatokenzzzz" });
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain("STARFISH_TWILIO_AUTH_TOKEN is not a Twilio auth token");
    expect(bad.out).not.toContain("notatokenzzzz");
  });
});

describe("scripts/deploy-gcp.sh: the agent's Slack webhook (#17)", () => {
  const agent = { ...dry, DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_CHECKS: "verify", STARFISH_GITHUB_TOKEN: "ghp_x" };
  const HOOK = "https://hooks.slack.com/services/T000AAAA/B000BBBB/" + "x".repeat(24);

  it("creates and mounts nothing for Slack when no webhook is given", () => {
    const r = deploy(agent);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("starfish-slack-oncall");
    expect(r.out).not.toContain("STARFISH_SLACK_WEBHOOK_ONCALL");
  });

  it("stores the webhook in its own secret for the agent's account only, over stdin, and never prints it", () => {
    const r = deploy({ ...agent, STARFISH_SLACK_WEBHOOK_ONCALL: HOOK });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(HOOK);
    expect(r.out).toContain("gcloud secrets create starfish-slack-oncall");
    expect(r.out).toContain("<STARFISH_SLACK_WEBHOOK_ONCALL> | gcloud secrets versions add starfish-slack-oncall --data-file=-");
    const bindings = r.out.split("\n").filter((l) => l.includes("add-iam-policy-binding starfish-slack-oncall"));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toContain("--member=serviceAccount:starfish-agent@star-proj.iam.gserviceaccount.com");
  });

  it("mounts it on the agent job only, in ONE secrets flag beside the GitHub token", () => {
    const r = deploy({ ...agent, STARFISH_SLACK_WEBHOOK_ONCALL: HOOK });
    const agentDeploy = r.out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-agent")) ?? "";
    const ingestDeploy = r.out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-ingest")) ?? "";
    expect(agentDeploy).toContain("--update-secrets=STARFISH_GITHUB_TOKEN=starfish-github-token:latest,STARFISH_SLACK_WEBHOOK_ONCALL=starfish-slack-oncall:latest");
    expect(agentDeploy.match(/--update-secrets/g)).toHaveLength(1);
    expect(ingestDeploy).not.toContain("SLACK");
  });

  it("refuses a value that is not a Slack webhook, without echoing it", () => {
    const bad = "https://evil.example/services/T000AAAA/B000BBBB/secretvalue";
    const r = deploy({ ...agent, STARFISH_SLACK_WEBHOOK_ONCALL: bad });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("is not a Slack incoming-webhook URL");
    expect(r.out).not.toContain("secretvalue");
  });

  const ALERTS = "https://hooks.slack.com/services/T000AAAA/B000CCCC/" + "y".repeat(24);

  it("stores the optional #ops-alerts webhook in a second secret of its own, for the agent's account only, never printed", () => {
    const r = deploy({ ...agent, STARFISH_SLACK_WEBHOOK_ALERTS: ALERTS });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(ALERTS);
    expect(r.out).toContain("gcloud secrets create starfish-slack-alerts");
    expect(r.out).toContain("<STARFISH_SLACK_WEBHOOK_ALERTS> | gcloud secrets versions add starfish-slack-alerts --data-file=-");
    const bindings = r.out.split("\n").filter((l) => l.includes("add-iam-policy-binding starfish-slack-alerts"));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toContain("--member=serviceAccount:starfish-agent@star-proj.iam.gserviceaccount.com");
    // the on-call secret is untouched when only the alerts webhook is given
    expect(r.out).not.toContain("starfish-slack-oncall");
  });

  it("mounts both on the agent job only, in ONE secrets flag, and neither on the ingest", () => {
    const r = deploy({ ...agent, STARFISH_SLACK_WEBHOOK_ONCALL: HOOK, STARFISH_SLACK_WEBHOOK_ALERTS: ALERTS });
    const agentDeploy = r.out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-agent")) ?? "";
    const ingestDeploy = r.out.split("\n").find((l) => l.includes("gcloud run jobs deploy starfish-ingest")) ?? "";
    expect(agentDeploy).toContain(
      "--update-secrets=STARFISH_GITHUB_TOKEN=starfish-github-token:latest,STARFISH_SLACK_WEBHOOK_ONCALL=starfish-slack-oncall:latest,STARFISH_SLACK_WEBHOOK_ALERTS=starfish-slack-alerts:latest"
    );
    expect(agentDeploy.match(/--update-secrets/g)).toHaveLength(1);
    expect(ingestDeploy).not.toContain("SLACK");
  });

  it("refuses an alerts value that is not a Slack webhook, by name, without echoing it", () => {
    const r = deploy({ ...agent, STARFISH_SLACK_WEBHOOK_ALERTS: "https://evil.example/services/T/B/alertsecret" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("STARFISH_SLACK_WEBHOOK_ALERTS is not a Slack incoming-webhook URL");
    expect(r.out).not.toContain("alertsecret");
  });
});

// --update-env-vars keeps a name it is not given, so a setting the script adds only when it is non-empty would stay on the
// job after it is cleared (#233). These are always set, empty included, and empty is the engine's default.
describe("scripts/deploy-gcp.sh: settings that must revert when cleared (#229, #233)", () => {
  const agent = { ...dry, DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_CHECKS: "verify" };
  const admin = { ...dry, DEPLOY_ADMIN_API: "1" };
  // The "@"-separated settings of one deployed job or service, as [name, value] pairs.
  const settings = (out, command) => {
    const l = out.split("\n").find((x) => x.includes(command)) ?? "";
    const list = /--update-env-vars=\^@\^(.*?)(?= --[a-z]|$)/.exec(l)?.[1] ?? "";
    return list.split("@").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]);
  };
  const values = (out, command, name) => settings(out, command).filter(([n]) => n === name).map(([, v]) => v);
  const agentJob = "gcloud run jobs deploy starfish-agent";
  const adminService = "gcloud run deploy starfish-admin";

  it("sets whose check runs count on the agent, with either isolation, empty meaning the engine's default (#229)", () => {
    const isolations = [{}, { VERIFY_ISOLATION: "cloud-run-job", VERIFY_COMMAND: "pnpm test" }];
    for (const isolation of isolations) {
      const unset = deploy({ ...agent, ...isolation });
      expect(unset.status).toBe(0);
      expect(values(unset.out, agentJob, "STARFISH_VERIFY_CHECK_APP")).toEqual([""]);
      const set = deploy({ ...agent, ...isolation, VERIFY_CHECK_APP: "my-ci-app" });
      expect(set.status).toBe(0);
      expect(values(set.out, agentJob, "STARFISH_VERIFY_CHECK_APP")).toEqual(["my-ci-app"]);
    }
    // Never on the ingest job or the admin API, which judge no checks.
    const both = deploy({ ...agent, DEPLOY_ADMIN_API: "1", VERIFY_CHECK_APP: "my-ci-app" });
    expect(values(both.out, "gcloud run jobs deploy starfish-ingest", "STARFISH_VERIFY_CHECK_APP")).toEqual([]);
    expect(values(both.out, adminService, "STARFISH_VERIFY_CHECK_APP")).toEqual([]);
  });

  it("refuses a check app that is not a GitHub App's slug, and the setting through either extra list", () => {
    for (const bad of ["My-App", "a_b", "a b", "a@b", "-ci", "ci-", "ci/app", "a,b"]) {
      const r = deploy({ ...agent, VERIFY_CHECK_APP: bad });
      expect(r.status, bad).not.toBe(0);
      expect(r.out, bad).toContain("VERIFY_CHECK_APP must be a GitHub App's slug");
      expect(r.out, bad).not.toContain("gcloud ");
    }
    for (const list of ["EXTRA_ENV_VARS", "AGENT_EXTRA_ENV_VARS"]) {
      const r = deploy({ ...agent, [list]: "STARFISH_VERIFY_CHECK_APP=other-app" });
      expect(r.status, list).not.toBe(0);
      expect(r.out, list).toContain("may not set STARFISH_VERIFY_*");
    }
  });

  it("always sets the agent's base branch, so clearing AGENT_BASE_BRANCH restores main (#233)", () => {
    expect(values(deploy({ ...agent, AGENT_BASE_BRANCH: "develop" }).out, agentJob, "STARFISH_GITHUB_BASE_BRANCH")).toEqual(["develop"]);
    expect(values(deploy(agent).out, agentJob, "STARFISH_GITHUB_BASE_BRANCH")).toEqual([""]);
    // A list that sets the name keeps it, once; with AGENT_BASE_BRANCH as well it is set twice, and refused.
    for (const list of ["EXTRA_ENV_VARS", "AGENT_EXTRA_ENV_VARS"]) {
      const r = deploy({ ...agent, [list]: "STARFISH_GITHUB_BASE_BRANCH=release" });
      expect(r.status, list).toBe(0);
      expect(values(r.out, agentJob, "STARFISH_GITHUB_BASE_BRANCH"), list).toEqual(["release"]);
      const twice = deploy({ ...agent, AGENT_BASE_BRANCH: "develop", [list]: "STARFISH_GITHUB_BASE_BRANCH=release" });
      expect(twice.status, list).not.toBe(0);
      expect(twice.out, list).toContain("STARFISH_GITHUB_BASE_BRANCH is set twice");
    }
  });

  it("always sets the admin API's browser origins, so clearing ADMIN_API_ORIGINS allows none again (#233)", () => {
    expect(values(deploy({ ...admin, ADMIN_API_ORIGINS: "https://site.web.app" }).out, adminService, "STARFISH_ADMIN_API_ORIGINS")).toEqual(["https://site.web.app"]);
    expect(values(deploy(admin).out, adminService, "STARFISH_ADMIN_API_ORIGINS")).toEqual([""]);
    const listed = deploy({ ...admin, EXTRA_ENV_VARS: "STARFISH_ADMIN_API_ORIGINS=https://hosted.web.app" });
    expect(listed.status).toBe(0);
    expect(values(listed.out, adminService, "STARFISH_ADMIN_API_ORIGINS")).toEqual(["https://hosted.web.app"]);
    const twice = deploy({ ...admin, ADMIN_API_ORIGINS: "https://site.web.app", EXTRA_ENV_VARS: "STARFISH_ADMIN_API_ORIGINS=https://hosted.web.app" });
    expect(twice.status).not.toBe(0);
    expect(twice.out).toContain("STARFISH_ADMIN_API_ORIGINS is set twice");
  });
});
