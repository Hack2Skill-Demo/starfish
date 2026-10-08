// scripts/deploy-web.sh deploys to a real project, so these pin what a dry run promises: it refuses the
// unsafe inputs, prints the whole plan, changes nothing (it only reads), and keeps Starfish off the project's
// default site. And that the site it deploys to ends up linked to Starfish's web app (#156).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./deploy-web.sh", import.meta.url).pathname;

// A pnpm first on PATH that logs every call and answers only the two reads a dry run may make, from canned replies
// (`site`: the hosting:sites:get reply; `apps`: the apps:list reply; either absent = that read fails, as when the
// shell is not signed in). Anything else it is asked to do fails, and shows up in `calls`.
function deploy(env, { site, apps } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pnpm-stub-"));
  const log = join(dir, "calls");
  const reply = (name, body) => {
    if (body === undefined) return "exit 1";
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
    // pnpm dlx may print progress before the CLI's JSON; the script must cope.
    return `echo "Progress: resolved 1"; cat "${join(dir, name)}"; exit 0`;
  };
  writeFileSync(
    join(dir, "pnpm"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "run build") env > "${join(dir, "build-env")}"; exit 0 ;;
  *"hosting:sites:get"*) ${reply("site.json", site)} ;;
  *"apps:list WEB"*) ${reply("apps.json", apps)} ;;
esac
exit 1
`,
  );
  chmodSync(join(dir, "pnpm"), 0o755);
  // gcloud and curl are stubbed too: a dry run must call neither (every call shows up in `calls`).
  for (const tool of ["gcloud", "curl"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 1\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  const r = spawnSync("bash", [script], {
    env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  // The environment the build ran with (a run that is not a dry run), as name -> value.
  const buildEnvFile = join(dir, "build-env");
  const buildEnv = existsSync(buildEnvFile)
    ? Object.fromEntries(readFileSync(buildEnvFile, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
    : undefined;
  return { ...r, out: `${r.stdout}${r.stderr}`.replace(/\\/g, ""), calls, buildEnv };
}

const READS = /^dlx firebase-tools@14 (hosting:sites:get|apps:list) /;
const onlyReads = (calls) => calls.every((c) => READS.test(c));

const ok = (result) => ({ status: "success", result });
const siteReply = (appId) =>
  ok({ name: "projects/star-proj/sites/star-proj-starfish", type: "USER_SITE", ...(appId ? { appId } : {}) });
const appsReply = ok([
  { appId: "1:111:web:watched", displayName: "the-watched-app", platform: "WEB" },
  { appId: "1:111:web:starfish", displayName: "starfish", platform: "WEB" },
]);

const dry = { DRY_RUN: "1", PROJECT_ID: "star-proj" };

describe("scripts/deploy-web.sh", () => {
  it("needs a project", () => {
    const r = deploy({ DRY_RUN: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("PROJECT_ID is required");
  });

  it("refuses the default database and an invalid site name", () => {
    expect(deploy({ ...dry, STARFISH_DATABASE_ID: "(default)" }).status).not.toBe(0);
    const r = deploy({ ...dry, HOSTING_SITE: "Bad_Site" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("HOSTING_SITE must be");
  });

  it("prints the whole plan and runs nothing but reads, even when the reads fail", () => {
    const r = deploy(dry);
    expect(r.status).toBe(0);
    expect(r.calls.length).toBeGreaterThan(0);
    expect(onlyReads(r.calls)).toBe(true);
    for (const part of [
      "VITE_STARFISH_ENV=dev",
      "VITE_STARFISH_DATABASE_ID=starfish",
      "pnpm run build",
      "apps:create WEB starfish --project star-proj",
      "hosting:sites:create star-proj-starfish --app <web-app-id>",
      "target:apply hosting starfish star-proj-starfish",
      "deploy --only hosting:starfish --project star-proj",
    ]) {
      expect(r.out).toContain(part);
    }
    expect(r.out).toContain("Dry run: nothing was changed.");
  });

  it("deploys to its own site by default, never the project's default one", () => {
    const r = deploy(dry);
    expect(r.out).toContain("star-proj-starfish");
    expect(r.out).not.toMatch(/target:apply hosting starfish star-proj( |$)/m);
  });

  // The Deploy web UI workflow hands these over as repository variables (#230): the build must see them, or an Actions
  // deploy hides the admin controls. A real (not dry) run against the stubs: the build is the first thing it runs.
  it("builds with the admin API's URL and the stale threshold it is given", () => {
    const r = deploy({ PROJECT_ID: "star-proj", VITE_STARFISH_ADMIN_API_URL: "https://starfish-admin-abc-uc.a.run.app", VITE_STARFISH_STALE_MINUTES: "20" });
    expect(r.buildEnv).toBeDefined();
    expect(r.buildEnv.VITE_STARFISH_ADMIN_API_URL).toBe("https://starfish-admin-abc-uc.a.run.app");
    expect(r.buildEnv.VITE_STARFISH_STALE_MINUTES).toBe("20");
    expect(r.buildEnv.VITE_STARFISH_ENV).toBe("dev");
  });

  it("takes the site and the environment label it is given", () => {
    const r = deploy({ ...dry, HOSTING_SITE: "judges", STARFISH_ENV: "demo" });
    expect(r.out).toContain("target:apply hosting starfish judges");
    expect(r.out).toContain("VITE_STARFISH_ENV=demo");
  });

  describe("links the site to Starfish's web app, so init.json has an appId (#156)", () => {
    it("a new site: created linked to the web app named starfish, never another app in the project", () => {
      const r = deploy(dry, { apps: appsReply });
      expect(r.status).toBe(0);
      expect(onlyReads(r.calls)).toBe(true);
      expect(r.out).toContain("hosting:sites:create star-proj-starfish --app 1:111:web:starfish --project star-proj");
      expect(r.out).not.toContain("web:watched");
      expect(r.out).not.toContain("apps:create");
      expect(r.out).not.toContain("curl -X PATCH");
    });

    it("a new site in a project with no starfish app: registers one, once", () => {
      const r = deploy(dry, { apps: ok([{ appId: "1:111:web:watched", displayName: "the-watched-app" }]) });
      expect(r.status).toBe(0);
      expect(r.out.match(/apps:create WEB starfish/g)).toHaveLength(1);
      expect(r.out).toContain("hosting:sites:create star-proj-starfish --app <web-app-id>");
      expect(r.out).not.toContain("web:watched");
    });

    it("an existing site linked to no app: linked to the starfish app with sites.patch, not created again", () => {
      const r = deploy(dry, { site: siteReply(), apps: appsReply });
      expect(r.status).toBe(0);
      expect(onlyReads(r.calls)).toBe(true);
      expect(r.out).not.toContain("hosting:sites:create");
      expect(r.out).not.toContain("apps:create");
      expect(r.out).toContain("curl -X PATCH");
      expect(r.out).toContain('{"appId":"1:111:web:starfish"}');
      expect(r.out).toContain(
        "https://firebasehosting.googleapis.com/v1beta1/projects/star-proj/sites/star-proj-starfish?updateMask=appId",
      );
      expect(r.out).toContain("target:apply hosting starfish star-proj-starfish");
    });

    it("an existing site already linked: left as it is, nothing created or linked", () => {
      const r = deploy(dry, { site: siteReply("1:111:web:earlier"), apps: appsReply });
      expect(r.status).toBe(0);
      expect(r.calls.every((c) => c.includes("hosting:sites:get"))).toBe(true);
      expect(r.out).toContain("linked to web app 1:111:web:earlier");
      expect(r.out).not.toContain("hosting:sites:create");
      expect(r.out).not.toContain("apps:create");
      expect(r.out).not.toContain("curl -X PATCH");
      expect(r.out).toContain("deploy --only hosting:starfish --project star-proj");
    });

    it("never links the project's default site, which is the watched app's", () => {
      const r = deploy({ ...dry, HOSTING_SITE: "star-proj" }, { site: siteReply(), apps: appsReply });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("default Hosting site");
      expect(r.out).not.toContain("curl -X PATCH");
    });

    it("refuses a site reply it cannot parse rather than guessing", () => {
      const r = deploy(dry, { site: "not json" });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("could not read hosting:sites:get");
    });
  });

  describe("App Check (#12)", () => {
    it("refuses to build with a debug token: it is a credential and would ship in the bundle", () => {
      const r = deploy({ ...dry, VITE_STARFISH_APPCHECK_DEBUG_TOKEN: "11111111-2222-3333-4444-555555555555" });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("debug token is for local development only");
      expect(r.calls).toEqual([]);
    });

    it("passes a site key to the build like any other VITE_ value, and never touches enforcement", () => {
      const r = deploy({ ...dry, VITE_STARFISH_APPCHECK_SITE_KEY: "6Lc-site-key" });
      expect(r.status).toBe(0);
      expect(r.out).not.toMatch(/firebaseappcheck|enforcementMode/);
    });
  });

  describe("uptime check and alert (#12)", () => {
    const channels = "projects/star-proj/notificationChannels/123,projects/star-proj/notificationChannels/456";

    it("is off unless asked for", () => {
      const r = deploy(dry);
      expect(r.out).not.toContain("monitoring");
    });

    it("plans the check on the site's init.json, and an alert on it, without calling gcloud or curl", () => {
      const r = deploy({ ...dry, UPTIME_CHECK: "1", UPTIME_NOTIFICATION_CHANNELS: channels });
      expect(r.status).toBe(0);
      expect(onlyReads(r.calls)).toBe(true);
      for (const part of [
        "gcloud services enable monitoring.googleapis.com --project=star-proj",
        "gcloud monitoring uptime create starfish-web star-proj-starfish --project=star-proj",
        "--resource-type=uptime-url --resource-labels=host=star-proj-starfish.web.app,project_id=star-proj",
        "--protocol=https --path=/__/firebase/init.json --validate-ssl=true",
        "--period=5",
        "curl -X POST",
        "https://monitoring.googleapis.com/v3/projects/star-proj/alertPolicies",
      ]) {
        expect(r.out).toContain(part);
      }
      expect(r.out).not.toContain("Bearer ya29");
      // The policy printed in the plan is valid JSON, tied to the check and the channels.
      const lines = r.stdout.split("\n");
      const start = lines.findIndex((l) => l.startsWith('{"displayName"'));
      const end = lines.findIndex((l, i) => i > start && l.endsWith("}}}]}"));
      const policy = JSON.parse(lines.slice(start, end + 1).join("\n"));
      expect(policy.displayName).toBe("starfish-web down: star-proj-starfish");
      expect(policy.notificationChannels).toEqual(channels.split(","));
      expect(policy.conditions[0].conditionThreshold.filter).toContain('metric.label.check_id="<uptime-check-id>"');
      expect(policy.conditions[0].conditionThreshold.filter).toContain("uptime_check/check_passed");
    });

    it("an alert with no channels has an empty list, and still plans", () => {
      const r = deploy({ ...dry, UPTIME_CHECK: "1" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('"notificationChannels":[]');
    });

    it("refuses a notification channel that is not a channel's full name", () => {
      for (const bad of ["123", "projects/p/notificationChannels/abc", 'projects/p/notificationChannels/1","x']) {
        const r = deploy({ ...dry, UPTIME_CHECK: "1", UPTIME_NOTIFICATION_CHANNELS: bad });
        expect(r.status, bad).not.toBe(0);
        expect(r.out).toContain("UPTIME_NOTIFICATION_CHANNELS takes");
      }
    });
  });
});
