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
  *"hosting:sites:get"*) ${reply("site.json", site)} ;;
  *"apps:list WEB"*) ${reply("apps.json", apps)} ;;
esac
exit 1
`,
  );
  chmodSync(join(dir, "pnpm"), 0o755);
  const r = spawnSync("bash", [script], {
    env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...r, out: `${r.stdout}${r.stderr}`.replace(/\\/g, ""), calls };
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
});
