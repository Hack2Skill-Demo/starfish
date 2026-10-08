// .github/workflows/deploy.yml can't be run from a test, so this pins the properties that make it safe
// to run (#75): triggered by hand or by a push to main that a person has switched on, keyless, nothing deployment-specific in the file, and every
// third-party action pinned to a commit. It reads the YAML as text on purpose: no parser dependency.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = new URL("../.github/workflows/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const deploy = read("deploy.yml");
const script = readFileSync(new URL("./deploy-gcp.sh", import.meta.url), "utf8");

// The YAML without its comment lines, so prose about secrets is not mistaken for using one.
const code = (text) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

// A dry run of either script proves nothing about the sign-in (#175): deploy-gcp.sh makes no gcloud call, deploy-web.sh's
// reads fail open, and the auth action only writes a credentials file. So the dry-run path makes authenticated,
// read-only calls in a step that fails the job, before the deploy step.
function expectSignInCheck(text) {
  const body = code(text);
  const step = body.split("- name: Check the sign-in (dry run only)")[1]?.split(/\n {6}- /)[0] ?? "";
  expect(step).toMatch(/^ {8}if: inputs\.dry_run$/m);
  expect(step).toContain(`gcloud projects describe "$PROJECT_ID"`);
  expect(step).toContain(`gcloud iam service-accounts describe "$GCP_DEPLOY_SERVICE_ACCOUNT" --project="$PROJECT_ID"`);
  // Nothing that could hide a failure.
  expect(step).not.toMatch(/\|\| true|continue-on-error|set \+e/);
  expect(step).toMatch(/^ {10}PROJECT_ID: \$\{\{ vars\.STARFISH_GCP_PROJECT_ID \}\}$/m);
  expect(step).toMatch(/^ {10}GCP_DEPLOY_SERVICE_ACCOUNT: \$\{\{ vars\.GCP_DEPLOY_SERVICE_ACCOUNT \}\}$/m);
  const at = (needle) => body.indexOf(needle);
  expect(at("google-github-actions/auth@")).toBeLessThan(at("- name: Check the sign-in"));
  expect(at("google-github-actions/setup-gcloud@")).toBeLessThan(at("- name: Check the sign-in"));
  expect(at("- name: Check the sign-in")).toBeLessThan(at("- name: Deploy"));
  // The input says what it checks, and no more.
  const input = body.match(/^ {6}dry_run:\n {8}description: (.*)$/m)?.[1] ?? "";
  expect(input).toContain("read-only gcloud calls check the Workload Identity sign-in");
  expect(input).not.toMatch(/proves|still builds/);
}

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
    // The admin API's settings too (#177), so a workflow run can deploy it.
    const vars = code(deploy).split("- name: Deploy")[1] ?? "";
    expect(vars).toMatch(/^ {10}DEPLOY_ADMIN_API: \$\{\{ vars\.STARFISH_DEPLOY_ADMIN_API \}\}$/m);
    expect(vars).toMatch(/^ {10}ADMIN_API_ORIGINS: \$\{\{ vars\.STARFISH_ADMIN_API_ORIGINS \}\}$/m);
    // Whose check runs count (#229): the script refuses STARFISH_VERIFY_* in the extra lists, so this is the only way.
    expect(vars).toMatch(/^ {10}VERIFY_CHECK_APP: \$\{\{ vars\.STARFISH_VERIFY_CHECK_APP \}\}$/m);
    // The script never receives user input by interpolation into shell text.
    expect(code(deploy).match(/run: [^\n]*\$\{\{/g)).toBeNull();
  });
});

describe("a dry run of either deploy workflow (#175)", () => {
  it("checks the Workload Identity sign-in with read-only calls that fail the run", () => {
    expectSignInCheck(deploy);
    expectSignInCheck(read("deploy-web.yml"));
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
    expect(on).not.toContain("pull_request");
    expect(code(web)).toMatch(/^ {4}if: github\.event_name == 'workflow_dispatch' \|\| vars\.STARFISH_DEPLOY_ON_MERGE == 'true'$/m);
  });

  // The UI bundles some engine files (the shared schemas): a change to one changes the site, so it must start a deploy
  // (#178). Derived from the imports, so a new shared file cannot be missed.
  it("runs on a push that changes any engine file the UI bundles", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const sources = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(join(d, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(d, e.name)] : []);
    // Relative imports only (a package is not a file of this repository); "./x.js" is the ESM spelling of x.ts.
    const imports = (file) => [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)]
      .map((m) => resolve(dirname(file), m[1]).replace(/\.js$/, ".ts"))
      .map((p) => (/\.tsx?$/.test(p) ? p : `${p}.ts`));
    const shared = new Set();
    const queue = sources(join(root, "web/src")).flatMap(imports).filter((p) => !relative(root, p).startsWith("web/"));
    while (queue.length > 0) {
      const file = queue.pop();
      const path = relative(root, file);
      if (shared.has(path)) continue;
      shared.add(path);
      queue.push(...imports(file));
    }
    expect([...shared]).toContain("src/settingsSchema.ts");
    expect([...shared]).toContain("src/oncallSchema.ts");
    const on = code(web).match(/^on:\n((?: {2,}.*\n|\n)+)/m)?.[1] ?? "";
    for (const path of shared) expect(on, `${path} is bundled by web/ but does not start a deploy`).toContain(`'${path}'`);
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

  // Without the admin API's URL an Actions deploy builds a UI with the admin controls hidden (#230).
  it("hands the build the admin API's URL and the stale threshold, through the environment", () => {
    const env = code(web).split("- name: Deploy")[1] ?? "";
    expect(env).toMatch(/^ {10}VITE_STARFISH_ADMIN_API_URL: \$\{\{ vars\.STARFISH_WEB_ADMIN_API_URL \}\}$/m);
    expect(env).toMatch(/^ {10}VITE_STARFISH_STALE_MINUTES: \$\{\{ vars\.STARFISH_WEB_STALE_MINUTES \}\}$/m);
    const docs = readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8");
    for (const name of ["STARFISH_WEB_ADMIN_API_URL", "STARFISH_WEB_STALE_MINUTES"]) expect(docs).toContain(name);
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
