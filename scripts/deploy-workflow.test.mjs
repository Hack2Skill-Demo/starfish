// .github/workflows/deploy.yml can't be run from a test, so this pins the properties that make it safe
// to run (#75): triggered by hand or by a push to main that a person has switched on, keyless, nothing deployment-specific in the file, and every
// third-party action pinned to a commit. It reads the YAML as text on purpose: no parser dependency.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../.github/workflows/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const deploy = read("deploy.yml");
const script = readFileSync(new URL("./deploy-gcp.sh", import.meta.url), "utf8");

// The YAML without its comment lines, so prose about secrets is not mistaken for using one.
const code = (text) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe(".github/workflows/deploy.yml", () => {
  it("is started by hand, or by a push to main, which does nothing until deploy-on-merge is switched on", () => {
    const on = code(deploy).match(/^on:\n((?: {2,}.*\n|\n)+)/m)?.[1] ?? "";
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(["  push:", "  workflow_dispatch:"]);
    // Only main, only files that change what the engine runs, and never a test file.
    expect(on).toMatch(/^ {4}branches: \[main\]$/m);
    expect(on).toContain("'src/**'");
    expect(on).toContain("'!src/**/*.test.ts'");
    expect(on).toContain("'scripts/deploy-gcp.sh'");
    expect(on).not.toContain("pull_request");
    // The push is gated by a repository variable a person sets; a hand-started run is not.
    expect(code(deploy)).toMatch(/^ {4}if: github\.event_name == 'workflow_dispatch' \|\| vars\.STARFISH_DEPLOY_ON_MERGE == 'true'$/m);
  });

  it("authenticates keylessly, and hands the script no GitHub token", () => {
    const body = code(deploy);
    expect(body).toContain("google-github-actions/auth@");
    expect(body).toContain("workload_identity_provider:");
    expect(body).not.toContain("credentials_json");
    expect(body).not.toMatch(/\bsecrets\./);
    expect(body).not.toMatch(/GITHUB_TOKEN|STARFISH_GITHUB_TOKEN/);
    expect(body).not.toMatch(/set -x|xtrace/);
  });

  it("asks for the OIDC token on the deploy job only, and runs it in the protected environment", () => {
    const body = code(deploy);
    expect(body.match(/id-token: write/g)).toHaveLength(1);
    expect(body).toMatch(/^ {4}environment: deploy$/m);
    // The provider's attribute condition in docs/deploy.md names this environment.
    expect(readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8")).toContain("assertion.environment == 'deploy'");
  });

  it("holds no deployment-specific value: each comes from a repository variable", () => {
    const body = code(deploy);
    expect(body).not.toMatch(/[a-z0-9-]+\.iam\.gserviceaccount\.com/);
    expect(body).not.toMatch(/projects\/\d+/);
    const env = body.split("- name: Deploy")[1] ?? "";
    for (const name of ["PROJECT_ID", "REGION", "SCHEDULE", "STARFISH_ENV", "EXTRA_ENV_VARS"]) {
      expect(env).toMatch(new RegExp(`^ {10}${name}: \\$\\{\\{ vars\\.`, "m"));
    }
  });

  it("passes only settings the script documents, and runs it unchanged", () => {
    const env = (code(deploy).split("- name: Deploy")[1] ?? "").match(/^ {10}([A-Z_]+):/gm) ?? [];
    expect(env.length).toBeGreaterThan(0);
    for (const line of env) {
      const name = line.trim().replace(":", "");
      expect(script, `${name} is not a setting of deploy-gcp.sh`).toMatch(new RegExp(`^#   ${name}\\b`, "m"));
    }
    expect(deploy).toMatch(/run: scripts\/deploy-gcp\.sh$/m);
    // The script never receives user input by interpolation into shell text.
    expect(code(deploy).match(/run: [^\n]*\$\{\{/g)).toBeNull();
  });
});

describe(".github/workflows/deploy-web.yml", () => {
  const web = read("deploy-web.yml");
  const webScript = readFileSync(new URL("./deploy-web.sh", import.meta.url), "utf8");

  it("is started by hand, or by a push to main, which does nothing until deploy-on-merge is switched on", () => {
    const on = code(web).match(/^on:\n((?: {2,}.*\n|\n)+)/m)?.[1] ?? "";
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(["  push:", "  workflow_dispatch:"]);
    expect(on).toMatch(/^ {4}branches: \[main\]$/m);
    expect(on).toContain("'web/**'");
    expect(on).toContain("'!web/**/*.test.ts'");
    expect(on).toContain("'src/settingsSchema.ts'");
    expect(on).not.toContain("pull_request");
    expect(code(web)).toMatch(/^ {4}if: github\.event_name == 'workflow_dispatch' \|\| vars\.STARFISH_DEPLOY_ON_MERGE == 'true'$/m);
  });

  it("authenticates keylessly in the protected environment, asks for the OIDC token on one job, and uses no secret", () => {
    const body = code(web);
    expect(body).toContain("google-github-actions/auth@");
    expect(body).toContain("workload_identity_provider:");
    expect(body).not.toContain("credentials_json");
    expect(body).not.toMatch(/\bsecrets\./);
    expect(body).not.toMatch(/GITHUB_TOKEN|STARFISH_GITHUB_TOKEN/);
    expect(body).not.toMatch(/set -x|xtrace/);
    expect(body.match(/id-token: write/g)).toHaveLength(1);
    expect(body).toMatch(/^ {4}environment: deploy$/m);
  });

  it("builds from a locked install, signs in before it deploys, and runs the script unchanged", () => {
    const body = code(web);
    expect(body).toMatch(/run: pnpm install --frozen-lockfile$/m);
    expect(body.indexOf("google-github-actions/auth@")).toBeLessThan(body.indexOf("- name: Deploy"));
    expect(web).toMatch(/run: scripts\/deploy-web\.sh$/m);
    expect(code(web).match(/run: [^\n]*\$\{\{/g)).toBeNull();
  });

  it("holds no deployment-specific value, and passes only settings the script documents", () => {
    const body = code(web);
    expect(body).not.toMatch(/[a-z0-9-]+\.iam\.gserviceaccount\.com/);
    expect(body).not.toMatch(/projects\/\d+/);
    const env = (body.split("- name: Deploy")[1] ?? "").match(/^ {10}([A-Z_]+): (.*)$/gm) ?? [];
    expect(env.length).toBeGreaterThan(0);
    for (const line of env) {
      const [name, value] = line.trim().split(/: (.*)/);
      expect(webScript, `${name} is not a setting of deploy-web.sh`).toMatch(new RegExp(`^#   ${name}\\b`, "m"));
      if (name !== "DRY_RUN") expect(value, `${name} must come from a repository variable`).toMatch(/^\$\{\{ vars\./);
    }
  });
});

describe("every workflow", () => {
  it("pins each third-party action to a full commit SHA", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));
    expect(files).toContain("deploy.yml");
    expect(files).toContain("deploy-web.yml");
    for (const f of files) {
      for (const [, ref] of code(read(f)).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        expect(ref, `${f}: ${ref}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      }
    }
  });
});
