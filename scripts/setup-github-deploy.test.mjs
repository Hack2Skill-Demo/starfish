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

const dry = { DRY_RUN: "1", PROJECT_ID: "star-proj", REPO: "acme/starfish" };

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

  it("trusts one repository in one environment, and nobody else", () => {
    const r = setup(dry);
    expect(r.out).toContain("--attribute-condition=assertion.repository == 'acme/starfish' && assertion.environment == 'deploy'");
    expect(r.out).toContain("workloadIdentityPools/github/attribute.repository/acme/starfish");
    expect(r.out).not.toMatch(/attribute\.repository\/\*|attribute\.repository_owner/);
    // The environment is a setting only so the workflows' fixed name and the provider's condition can be kept in step.
    expect(setup({ ...dry, ENVIRONMENT: "release" }).out).toContain("assertion.environment == 'release'");
  });

  it("makes no key and grants no basic role", () => {
    const r = setup(dry);
    expect(r.out).not.toMatch(/keys create|--key-file|credentials_json/);
    expect(r.out).not.toMatch(/roles\/(owner|editor|viewer)\b/);
    expect(r.out).not.toContain("roles/iam.serviceAccountTokenCreator");
  });

  it("limits what the deployer can grant to the roles the deploy script grants", () => {
    const r = setup(dry);
    const line = r.out.split("\n").find((l) => l.includes("roles/resourcemanager.projectIamAdmin")) ?? "";
    expect(line).toContain("^;^expression=");
    expect(line).toContain("hasOnly(['roles/logging.viewer','roles/datastore.user','roles/aiplatform.user','roles/run.builder'])");
    // Every project-level role deploy-gcp.sh binds is inside that list, so the limit does not stop the deploy.
    const deploy = spawnSync("bash", [new URL("./deploy-gcp.sh", import.meta.url).pathname], {
      env: { PATH: "/usr/bin:/bin", ...dry }, encoding: "utf8",
    });
    const bound = [...`${deploy.stdout}`.replace(/\\/g, "").matchAll(/projects add-iam-policy-binding \S+ --member=\S+ --role=(roles\/[\w.]+)/g)].map((m) => m[1]);
    expect(bound.length).toBeGreaterThan(0);
    for (const role of bound) expect(line, `${role} is bound by deploy-gcp.sh`).toContain(`'${role}'`);
  });

  it("lets the deployer act as only the four accounts the deploy uses, never project-wide", () => {
    const r = setup(dry);
    const acts = r.out.split("\n").filter((l) => l.includes("--role=roles/iam.serviceAccountUser"));
    expect(acts).toHaveLength(4);
    for (const l of acts) expect(l).toMatch(/service-accounts add-iam-policy-binding starfish-(engine|scheduler|agent|verifier)@/);
  });

  it("adds roles on the watched and Gemini projects only when they differ", () => {
    expect(setup(dry).out).not.toContain("add-iam-policy-binding app-proj");
    const r = setup({ ...dry, WATCHED_PROJECT_ID: "app-proj", VERTEX_PROJECT_ID: "ai-proj" });
    expect(r.out).toContain("add-iam-policy-binding app-proj");
    expect(r.out).toContain("add-iam-policy-binding ai-proj");
  });

  it("tells the person exactly what to set in GitHub, and that deploy-on-merge is a separate switch", () => {
    const r = setup(dry);
    for (const name of ["GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_DEPLOY_SERVICE_ACCOUNT", "STARFISH_GCP_PROJECT_ID", "STARFISH_DEPLOY_ON_MERGE = true"]) {
      expect(r.out).toContain(name);
    }
    expect(r.out).toContain('"deploy". Under "Deployment branches"');
  });
});
