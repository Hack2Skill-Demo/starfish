// scripts/setup-github-deploy.sh changes who may deploy into a real project, so these pin what a dry run promises:
// it refuses bad input, trusts exactly one repository in one environment, makes no key, and grants nothing broad.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./setup-github-deploy.sh", import.meta.url).pathname;

function setup(env) {
  const dir = mkdtempSync(join(tmpdir(), "wif-stub-"));
  const marker = join(dir, "called");
  for (const name of ["gcloud", "gh"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const r = spawnSync("bash", [script], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env }, encoding: "utf8" });
  return { ...r, out: `${r.stdout}${r.stderr}`.replace(/\\/g, ""), called: existsSync(marker) };
}

const dry = { DRY_RUN: "1", PROJECT_ID: "star-proj", REPO: "acme/starfish", REPO_ID: "123456" };
const roleOf = (l) => l.match(/--role=(\S+)/)?.[1];

describe("scripts/setup-github-deploy.sh", () => {
  it("needs a project and a repository written owner/name", () => {
    expect(setup({ DRY_RUN: "1", REPO: "a/b" }).out).toContain("PROJECT_ID is required");
    expect(setup({ DRY_RUN: "1", PROJECT_ID: "p" }).out).toContain("REPO is required");
    for (const bad of ["acme", "a/b/c", "/b", "a/", "a/..", "a b/c", "a/b;rm"]) {
      const r = setup({ ...dry, REPO: bad });
      expect(r.status, bad).not.toBe(0);
      expect(r.out, bad).toContain("REPO must be owner/name");
    }
    expect(setup({ ...dry, POOL: "x y" }).status).not.toBe(0);
  });

  it("prints the whole plan and runs nothing", () => {
    const r = setup(dry);
    expect(r.status).toBe(0);
    expect(r.called).toBe(false);
    for (const part of [
      "gcloud services enable iamcredentials.googleapis.com sts.googleapis.com",
      "workload-identity-pools create github",
      "providers create-oidc github-deploy",
      "gcloud iam service-accounts create starfish-deployer",
      "--role=roles/iam.workloadIdentityUser",
    ]) expect(r.out).toContain(part);
  });

  it("trusts one repository, by its id and not its reusable name, in one environment, and nobody else (#145)", () => {
    const r = setup(dry);
    expect(r.out).toContain("--attribute-condition=assertion.repository_id == '123456' && assertion.environment == 'deploy'");
    expect(r.out).toContain("attribute.repository_id=assertion.repository_id");
    expect(r.out).toContain("workloadIdentityPools/github/attribute.repository_id/123456");
    expect(r.out).not.toContain("assertion.repository ==");
    expect(r.out).not.toMatch(/attribute\.repository\/|attribute\.repository_owner/);
    // The environment is a setting only so the workflows' fixed name and the provider's condition can be kept in step.
    expect(setup({ ...dry, ENVIRONMENT: "release" }).out).toContain("assertion.environment == 'release'");
    for (const bad of ["12a", "1 2", "'1'"]) expect(setup({ ...dry, REPO_ID: bad }).status, bad).not.toBe(0);
    // A dry run with no id shows where it goes (a real run looks it up with gh, and stops if it cannot).
    expect(setup({ ...dry, REPO_ID: "" }).out).toContain("assertion.repository_id == '<id of acme/starfish>'");
  });

  it("makes no key and grants no basic role", () => {
    const r = setup(dry);
    expect(r.out).not.toMatch(/keys create|--key-file|credentials_json/);
    expect(r.out).not.toMatch(/roles\/(owner|editor|viewer)\b/);
    expect(r.out).not.toContain("roles/iam.serviceAccountTokenCreator");
  });

  it("never lets the deployer set the IAM policy of any account it likes, nor read every secret or bucket (#145)", () => {
    for (const env of [dry, { ...dry, VERIFY_ISOLATION: "cloud-run-job" }]) {
      const r = setup(env);
      // serviceAccountAdmin holds setIamPolicy on every account in the project, where the project-level condition never applies.
      expect(r.out).not.toContain("roles/iam.serviceAccountAdmin");
      const role = r.out.split("\n").find((l) => l.includes("iam roles create starfishDeployer")) ?? "";
      expect(role).toContain("--permissions=iam.serviceAccounts.create,iam.serviceAccounts.get,secretmanager.secrets.create,storage.buckets.create,storage.buckets.list");
      expect(role).not.toContain("setIamPolicy");
      expect(r.out).toContain("--role=projects/star-proj/roles/starfishDeployer --condition=None");
      // Secret Manager and Cloud Storage admin only on Starfish's own, by name.
      const project = r.out.split("\n").filter((l) => l.includes("projects add-iam-policy-binding star-proj"));
      for (const broad of ["roles/secretmanager.admin", "roles/storage.admin"]) {
        const lines = project.filter((l) => roleOf(l) === broad);
        expect(lines, broad).toHaveLength(1);
        expect(lines[0], broad).not.toContain("--condition=None");
        expect(lines[0], broad).toContain("^;^expression=");
      }
      const secrets = project.find((l) => roleOf(l) === "roles/secretmanager.admin");
      expect(secrets).toContain('resource.name == "projects/<project-number>/secrets/starfish-github-token"');
      expect(secrets).toContain('resource.name.startsWith("projects/<project-number>/secrets/starfish-slack-oncall/")');
      // #169: the #ops-alerts webhook is deploy-gcp.sh's secret too, so the deployer must be able to write it.
      expect(secrets).toContain('resource.name == "projects/<project-number>/secrets/starfish-slack-alerts"');
      for (const twilio of ["starfish-twilio-account-sid", "starfish-twilio-auth-token", "starfish-twilio-from-number"]) {
        expect(secrets).toContain(`resource.name == "projects/<project-number>/secrets/${twilio}"`);
      }
      expect(secrets).not.toMatch(/startsWith\("projects\/<project-number>\/secrets\/starfish-"\)/);
      const buckets = project.find((l) => roleOf(l) === "roles/storage.admin");
      expect(buckets).toContain('resource.name.startsWith("projects/_/buckets/run-sources-star-proj-")');
      expect(buckets).toContain('resource.name == "projects/_/buckets/star-proj_cloudbuild"');
    }
    // The verify bucket only with the isolation that has one; the agent account's own policy likewise, and no other's.
    expect(setup(dry).out).not.toContain("star-proj-starfish-verify");
    expect(setup(dry).out).not.toContain("starfishServiceAccountIam");
    const job = setup({ ...dry, VERIFY_ISOLATION: "cloud-run-job", VERIFY_BUCKET: "my-verify" });
    expect(job.out).toContain('resource.name == "projects/_/buckets/my-verify"');
    const iam = job.out.split("\n").filter((l) => l.includes("roles/starfishServiceAccountIam") && l.includes("add-iam-policy-binding"));
    expect(iam).toHaveLength(1);
    expect(iam[0]).toContain("service-accounts add-iam-policy-binding starfish-agent@star-proj");
    expect(job.out).toContain("--permissions=iam.serviceAccounts.get,iam.serviceAccounts.getIamPolicy,iam.serviceAccounts.setIamPolicy");
    expect(setup({ ...dry, VERIFY_ISOLATION: "in-process" }).status).not.toBe(0);
  });

  it("names the secrets and buckets deploy-gcp.sh uses, and refuses names that could reach a condition", () => {
    const r = setup({ ...dry, GITHUB_SECRET: "gh-tok", SLACK_SECRET: "slack-x", SLACK_ALERTS_SECRET: "slack-a" });
    expect(r.out).toContain("secrets/gh-tok");
    expect(r.out).toContain("secrets/slack-x");
    expect(r.out).toContain("secrets/slack-a");
    for (const bad of ['a"b', "a b", "a)||true"]) expect(setup({ ...dry, GITHUB_SECRET: bad }).status, bad).not.toBe(0);
  });

  // What the deployer may grant, project by project: the roles in each projectIamAdmin binding's hasOnly list.
  const grantable = (out) => {
    const byProject = new Map();
    for (const l of out.split("\n").filter((x) => x.includes("projects add-iam-policy-binding") && roleOf(x) === "roles/resourcemanager.projectIamAdmin")) {
      const project = l.match(/projects add-iam-policy-binding (\S+)/)[1];
      expect(byProject.has(project), `one projectIamAdmin binding on ${project}`).toBe(false);
      expect(l, project).toContain("^;^expression=");
      const list = l.match(/hasOnly\(\[([^\]]*)\]\)/)?.[1] ?? "";
      byProject.set(project, list.split(",").map((s) => s.replace(/'/g, "")).filter(Boolean).sort());
    }
    return byProject;
  };

  it("limits what the deployer can grant on each project to the roles the deploy script binds on that project (#228)", () => {
    // Every combination of the deploy's parts: the agent (both isolations), the admin API and the Monitoring signal (#176).
    const full = { DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_CHECKS: "verify", DEPLOY_ADMIN_API: "1" };
    const monitoring = { STARFISH_MONITORING_ENABLED: "true" };
    const parts = [
      {},
      monitoring,
      { DEPLOY_ADMIN_API: "1" },
      { ...monitoring, DEPLOY_ADMIN_API: "1" },
      full,
      { ...full, ...monitoring },
      { ...full, ...monitoring, VERIFY_ISOLATION: "cloud-run-job", VERIFY_COMMAND: "pnpm test" },
    ];
    // Where the three projects are one, two or three projects.
    for (const layout of [
      {},
      { WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "ai-proj" },
      { WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "app-proj" },
      { VERTEX_PROJECT_ID: "ai-proj" },
      { WATCHED_PROJECT_ID: "app-proj" },
    ]) {
      const bound = new Map();
      for (const extra of parts) {
        const deploy = spawnSync("bash", [new URL("./deploy-gcp.sh", import.meta.url).pathname], {
          env: { PATH: "/usr/bin:/bin", ...dry, ...layout, ...extra }, encoding: "utf8",
        });
        expect(deploy.status, deploy.stderr).toBe(0);
        for (const m of deploy.stdout.replace(/\\/g, "").matchAll(/projects add-iam-policy-binding (\S+) --member=\S+ --role=(roles\/[\w.]+)/g)) {
          bound.set(m[1], new Set([...(bound.get(m[1]) ?? []), m[2]]));
        }
      }
      // Exactly the roles deploy-gcp.sh binds there, with every part on: none missing (the deploy would be refused), none
      // more (the deployer could hand it to anyone).
      const limits = grantable(setup({ ...dry, ...layout }).out);
      const expected = new Map([...bound].map(([p, roles]) => [p, [...roles].sort()]));
      expect(limits, JSON.stringify(layout)).toEqual(expected);
    }
    // Spelled out: the watched project (the app's production) is never given Starfish's database or Auth roles (#213).
    const three = grantable(setup({ ...dry, WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "ai-proj" }).out);
    expect(three.get("app-proj")).toEqual(["roles/logging.viewer", "roles/monitoring.viewer"]);
    expect(three.get("ai-proj")).toEqual(["roles/aiplatform.user"]);
    expect(three.get("star-proj")).toEqual(["roles/datastore.user", "roles/firebaseauth.viewer", "roles/run.builder"]);
    expect(grantable(setup(dry).out).get("star-proj")).toEqual([
      "roles/aiplatform.user", "roles/datastore.user", "roles/firebaseauth.viewer", "roles/logging.viewer", "roles/monitoring.viewer", "roles/run.builder",
    ]);
  });

  it("takes off an earlier, wider projectIamAdmin binding before it binds the new one (#228)", () => {
    const lines = setup({ ...dry, WATCHED_PROJECT_ID: "app-proj" }).out.split("\n");
    for (const project of ["star-proj", "app-proj"]) {
      const remove = lines.findIndex((l) => l.includes(`remove-iam-policy-binding ${project} `) && l.includes("--role=roles/resourcemanager.projectIamAdmin --all"));
      const add = lines.findIndex((l) => l.includes(`projects add-iam-policy-binding ${project} `) && roleOf(l) === "roles/resourcemanager.projectIamAdmin");
      expect(remove, project).toBeGreaterThan(-1);
      expect(remove, project).toBeLessThan(add);
      expect(lines[remove]).toContain("--member=serviceAccount:starfish-deployer@star-proj.iam.gserviceaccount.com");
    }
  });

  it("lets the deployer act as only the five accounts the deploy uses, never project-wide", () => {
    const r = setup(dry);
    const acts = r.out.split("\n").filter((l) => l.includes("--role=roles/iam.serviceAccountUser"));
    expect(acts).toHaveLength(5);
    for (const l of acts) expect(l).toMatch(/service-accounts add-iam-policy-binding starfish-(engine|scheduler|agent|verifier|admin-api)@/);
    expect(r.out).not.toMatch(/projects add-iam-policy-binding \S+ --member=\S+ --role=roles\/iam\.serviceAccountUser/);
  });

  it("follows the account names deploy-gcp.sh was told to use", () => {
    const r = setup({ ...dry, ENGINE_SA_NAME: "ops-engine", AGENT_SA_NAME: "ops-agent", ADMIN_SA_NAME: "ops-admin", VERIFY_ISOLATION: "cloud-run-job" });
    const acts = r.out.split("\n").filter((l) => l.includes("--role=roles/iam.serviceAccountUser"));
    expect(acts.some((l) => l.includes("add-iam-policy-binding ops-engine@star-proj"))).toBe(true);
    expect(acts.some((l) => l.includes("add-iam-policy-binding ops-agent@star-proj"))).toBe(true);
    expect(acts.some((l) => l.includes("add-iam-policy-binding ops-admin@star-proj"))).toBe(true);
    expect(acts.some((l) => l.includes("starfish-engine@"))).toBe(false);
    expect(r.out).toContain("service-accounts add-iam-policy-binding ops-agent@star-proj.iam.gserviceaccount.com --project=star-proj --role=projects/star-proj/roles/starfishServiceAccountIam");
  });

  it("adds roles on the watched and Gemini projects only when they differ", () => {
    expect(setup(dry).out).not.toContain("add-iam-policy-binding app-proj");
    const r = setup({ ...dry, WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "ai-proj" });
    expect(r.out).toContain("add-iam-policy-binding app-proj");
    expect(r.out).toContain("add-iam-policy-binding ai-proj");
    // One project that is both the watched and the Gemini one gets each role once.
    const shared = setup({ ...dry, WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "app-proj" }).out.split("\n");
    for (const role of ["roles/serviceusage.serviceUsageAdmin", "roles/resourcemanager.projectIamAdmin"]) {
      expect(shared.filter((l) => l.includes("projects add-iam-policy-binding app-proj ") && roleOf(l) === role), role).toHaveLength(1);
    }
  });

  it("tells the person exactly what to set in GitHub, and that deploy-on-merge is a separate switch", () => {
    const r = setup(dry);
    for (const name of ["GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_DEPLOY_SERVICE_ACCOUNT", "STARFISH_GCP_PROJECT_ID", "STARFISH_DEPLOY_ON_MERGE = true"]) {
      expect(r.out).toContain(name);
    }
    expect(r.out).toContain('"deploy". Under "Deployment branches"');
  });
});
