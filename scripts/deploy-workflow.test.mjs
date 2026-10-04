// .github/workflows/deploy.yml can't be run from a test, so this pins the properties that make it safe
// to run (#75): triggered by hand only, keyless, nothing deployment-specific in the file, and every
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
  it("is started by hand and by nothing else", () => {
    const on = code(deploy).match(/^on:\n((?: {2,}.*\n|\n)+)/m)?.[1] ?? "";
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on.match(/^ {2}[a-z_]+:/gm)).toHaveLength(1);
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

describe("every workflow", () => {
  it("pins each third-party action to a full commit SHA", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));
    expect(files).toContain("deploy.yml");
    for (const f of files) {
      for (const [, ref] of code(read(f)).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        expect(ref, `${f}: ${ref}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      }
    }
  });
});
