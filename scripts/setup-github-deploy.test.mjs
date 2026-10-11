// scripts/setup-github-deploy.sh changes who may deploy into a real project, so these pin what a dry run promises:
// it refuses bad input, trusts exactly one repository in one environment, makes no key, and grants nothing broad.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("trusts one repository, by its id and not its reusable name, in one environment, on one branch, and nobody else (#145, #299)", () => {
    const r = setup(dry);
    expect(r.out).toContain(
      "--attribute-condition=assertion.repository_id == '123456' && assertion.environment == 'deploy' && assertion.ref == 'refs/heads/main' && assertion.ref_type == 'branch'",
    );
    expect(r.out).toContain("attribute.repository_id=assertion.repository_id");
    expect(r.out).toContain("attribute.ref=assertion.ref");
    expect(r.out).toContain("workloadIdentityPools/github/attribute.repository_id/123456");
    expect(r.out).not.toContain("assertion.repository ==");
    expect(r.out).not.toMatch(/attribute\.repository\/|attribute\.repository_owner/);
    // The environment is a setting only so the workflows' fixed name and the provider's condition can be kept in step.
    expect(setup({ ...dry, ENVIRONMENT: "release" }).out).toContain("assertion.environment == 'release'");
    for (const bad of ["12a", "1 2", "'1'"]) expect(setup({ ...dry, REPO_ID: bad }).status, bad).not.toBe(0);
    // A dry run with no id shows where it goes (a real run looks it up with gh, and stops if it cannot).
    expect(setup({ ...dry, REPO_ID: "" }).out).toContain("assertion.repository_id == '<id of acme/starfish>'");
  });

  it("checks the branch on the token itself: DEPLOY_BRANCH, and nothing that could leave the quotes (#299)", () => {
    const r = setup({ ...dry, DEPLOY_BRANCH: "release/v2" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("assertion.ref == 'refs/heads/release/v2' && assertion.ref_type == 'branch'");
    expect(r.out).toMatch(/add:\s+release\/v2\./);
    for (const bad of ["", "main' || true || '", "a b", "../main", "-main", "main/", "/main", "a//b", "a;b"]) {
      const b = setup({ ...dry, DEPLOY_BRANCH: bad });
      // An empty value is the default, main.
      if (bad === "") { expect(b.out).toContain("refs/heads/main"); continue; }
      expect(b.status, bad).not.toBe(0);
      expect(b.out, bad).toContain("DEPLOY_BRANCH must be a branch name");
    }
  });

  it("lets the deployer release the web UI to Hosting, and nothing on the project's Firebase apps (#265)", () => {
    const project = setup(dry).out.split("\n").filter((l) => l.includes("projects add-iam-policy-binding star-proj"));
    expect(project.map(roleOf)).toContain("roles/firebasehosting.admin");
    expect(project.map(roleOf).filter((r) => /^roles\/firebase\.|firebaseapp/.test(r ?? ""))).toEqual([]);
  });

  it("makes no key and grants no basic role", () => {
    const r = setup(dry);
    expect(r.out).not.toMatch(/keys create|--key-file|credentials_json/);
    // The one line that names a basic role is the check that the build account holds none (#300).
    expect(r.out.split("\n").filter((l) => !l.startsWith("+ (check)")).join("\n")).not.toMatch(/roles\/(owner|editor|viewer)\b/);
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

  it("with INDEX_TARGETS, lets the deployer grant the repair's two roles on each target's project and nowhere else, as the deploy binds them", () => {
    const layout = { WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "ai-proj", INDEX_TARGETS: "app-proj/(default),other-proj/(default)" };
    const deploy = spawnSync("bash", [new URL("./deploy-gcp.sh", import.meta.url).pathname], {
      env: { PATH: "/usr/bin:/bin", ...dry, ...layout, DEPLOY_AGENT: "1", AGENT_REPO: "acme/shop", VERIFY_CHECKS: "verify" },
      encoding: "utf8",
    });
    expect(deploy.status, deploy.stderr).toBe(0);
    const limits = grantable(setup({ ...dry, ...layout }).out);
    expect(limits.get("app-proj")).toEqual(["roles/datastore.indexAdmin", "roles/datastore.viewer", "roles/logging.viewer", "roles/monitoring.viewer"]);
    expect(limits.get("other-proj")).toEqual(["roles/datastore.indexAdmin", "roles/datastore.viewer"]);
    expect(limits.get("ai-proj")).toEqual(["roles/aiplatform.user"]);
    for (const m of deploy.stdout.replace(/\\/g, "").matchAll(/projects add-iam-policy-binding (\S+) --member=\S+ --role=(roles\/datastore\.(?:indexAdmin|viewer))/g)) {
      expect(limits.get(m[1]), m[1]).toContain(m[2]);
    }
    // Without targets, nothing of it: the watched project is never given a database role (#213).
    expect(grantable(setup({ ...dry, WATCHED_PROJECT_ID: "app-proj" }).out).get("app-proj")).toEqual(["roles/logging.viewer", "roles/monitoring.viewer"]);
    expect(setup({ ...dry, INDEX_TARGETS: "app-proj" }).status).not.toBe(0);
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

  it("lets the deployer act as only the five accounts the deploy uses and the one that builds its images, never project-wide", () => {
    const r = setup(dry);
    const acts = r.out.split("\n").filter((l) => l.includes("--role=roles/iam.serviceAccountUser"));
    expect(acts).toHaveLength(6);
    const build = acts.filter((l) => l.includes("-compute@developer.gserviceaccount.com"));
    // A build from source runs AS the build account, and Cloud Build refuses a caller that may not act as it.
    expect(build).toHaveLength(1);
    expect(build[0]).toContain("--member=serviceAccount:starfish-deployer@star-proj.iam.gserviceaccount.com");
    for (const l of acts.filter((x) => !build.includes(x))) expect(l).toMatch(/service-accounts add-iam-policy-binding starfish-(engine|scheduler|agent|verifier|admin-api)@/);
    // Named: that account instead of the default, and nothing that could reach a command line.
    const named = setup({ ...dry, BUILD_SERVICE_ACCOUNT: "starfish-builder@star-proj.iam.gserviceaccount.com" }).out;
    expect(named).toContain("service-accounts add-iam-policy-binding starfish-builder@star-proj.iam.gserviceaccount.com");
    expect(named).not.toContain("-compute@developer.gserviceaccount.com");
    expect(setup({ ...dry, BUILD_SERVICE_ACCOUNT: "x; rm -rf /" }).status).not.toBe(0);
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
    // #301: with deploy-on-merge a merge is a deploy (Dependabot's included), so reviewers are required, not optional.
    expect(r.out).toContain("Required reviewers: REQUIRED if you turn deploy-on-merge on");
    expect(r.out).not.toContain("leave it empty for a fully automatic one");
  });

  it("says in a dry run that it checks the build account before anything else", () => {
    const r = setup(dry);
    const check = r.out.indexOf("+ (check) gcloud projects get-iam-policy star-proj: <project-number>-compute@developer.gserviceaccount.com must hold neither roles/editor nor roles/owner");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(r.out.indexOf("gcloud services enable"));
    expect(setup({ ...dry, BUILD_SERVICE_ACCOUNT: "builder@star-proj.iam.gserviceaccount.com" }).out)
      .toContain("+ (check) gcloud projects get-iam-policy star-proj: builder@star-proj.iam.gserviceaccount.com must hold");
  });
});

// A real run (no DRY_RUN) against a gcloud that answers from STUB_* variables and logs every call: what the script
// does on a project that already has a provider, and on one whose build account is an Editor.
function live(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wif-live-"));
  const log = join(dir, "gcloud.log");
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "projects describe "*) echo 424242 ;;
  "projects get-iam-policy "*) [ "$STUB_POLICY_FAIL" = "1" ] && exit 1; printf '%s\\n' "$STUB_POLICY" ;;
  "iam workload-identity-pools providers describe "*) [ "$STUB_PROVIDER" = "1" ] || exit 1 ;;
esac
exit 0
`);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "gh $*" >> "${log}"\nexit 1\n`);
  chmodSync(join(dir, "gcloud"), 0o755);
  chmodSync(join(dir, "gh"), 0o755);
  const r = spawnSync("bash", [script], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`, PROJECT_ID: "star-proj", REPO: "acme/starfish", REPO_ID: "123456",
      STUB_POLICY: "roles/owner,user:me@example.com\nroles/run.builder,serviceAccount:424242-compute@developer.gserviceaccount.com",
      ...env,
    },
    encoding: "utf8",
  });
  const calls = readFileSync(log, { flag: "a+" }).toString().trim().split("\n").filter(Boolean);
  return { ...r, out: `${r.stdout}${r.stderr}`, calls };
}

describe("scripts/setup-github-deploy.sh, run against a stub of gcloud", () => {
  const changes = (calls) => calls.filter((c) => /\b(create|create-oidc|update|update-oidc|add-iam-policy-binding|remove-iam-policy-binding|enable)\b/.test(c));

  it("updates an existing provider to the branch condition, instead of leaving the old one (#299)", () => {
    const r = live({ STUB_PROVIDER: "1" });
    expect(r.status, r.out).toBe(0);
    const update = r.calls.filter((c) => c.startsWith("iam workload-identity-pools providers update-oidc github-deploy"));
    expect(update).toHaveLength(1);
    expect(update[0]).toContain("--attribute-condition=assertion.repository_id == '123456' && assertion.environment == 'deploy' && assertion.ref == 'refs/heads/main' && assertion.ref_type == 'branch'");
    expect(update[0]).toContain("attribute.ref=assertion.ref");
    expect(r.calls.some((c) => c.includes("providers create-oidc"))).toBe(false);
    // A project with no provider yet gets one with the same condition.
    const fresh = live();
    expect(fresh.calls.find((c) => c.includes("providers create-oidc github-deploy"))).toContain("assertion.ref == 'refs/heads/main'");
  });

  it("refuses, before it changes anything, while the build account is Editor or Owner of the project (#300)", () => {
    const compute = "serviceAccount:424242-compute@developer.gserviceaccount.com";
    for (const role of ["roles/editor", "roles/owner"]) {
      const r = live({ STUB_POLICY: `roles/owner,user:me@example.com\n${role},${compute}` });
      expect(r.status, role).not.toBe(0);
      expect(r.out, role).toContain(`424242-compute@developer.gserviceaccount.com, the account Cloud Run builds images as, holds ${role} on star-proj`);
      expect(r.out, role).toContain(`gcloud projects remove-iam-policy-binding star-proj --member=${compute} --role=${role} --all`);
      expect(r.out, role).toContain("BUILD_SERVICE_ACCOUNT");
      expect(changes(r.calls), role).toEqual([]);
    }
    // A named build account is the one checked.
    const named = live({ BUILD_SERVICE_ACCOUNT: "builder@star-proj.iam.gserviceaccount.com", STUB_POLICY: `roles/editor,${compute}\nroles/owner,serviceAccount:builder@star-proj.iam.gserviceaccount.com` });
    expect(named.status).not.toBe(0);
    expect(named.out).toContain("builder@star-proj.iam.gserviceaccount.com, the account Cloud Run builds images as, holds roles/owner");
    expect(changes(named.calls)).toEqual([]);
  });

  it("goes ahead when only some other account is Editor, and refuses when the policy cannot be read (#300)", () => {
    const compute = "serviceAccount:424242-compute@developer.gserviceaccount.com";
    const other = live({ BUILD_SERVICE_ACCOUNT: "builder@star-proj.iam.gserviceaccount.com", STUB_POLICY: `roles/editor,${compute}\nroles/run.builder,serviceAccount:builder@star-proj.iam.gserviceaccount.com` });
    expect(other.status, other.out).toBe(0);
    expect(other.calls.some((c) => c.startsWith("iam service-accounts add-iam-policy-binding builder@star-proj.iam.gserviceaccount.com"))).toBe(true);
    // A deleted account's leftover binding is not the account.
    expect(live({ STUB_POLICY: `roles/editor,deleted:${compute}?uid=1\nroles/owner,user:me@example.com` }).status).toBe(0);
    for (const unreadable of [{ STUB_POLICY_FAIL: "1" }, { STUB_POLICY: "" }]) {
      const r = live(unreadable);
      expect(r.status, JSON.stringify(unreadable)).not.toBe(0);
      expect(r.out).toContain("cannot read the IAM policy of star-proj");
      expect(changes(r.calls)).toEqual([]);
    }
  });
});
