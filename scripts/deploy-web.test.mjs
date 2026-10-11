// scripts/deploy-web.sh deploys to a real project, so these pin what a dry run promises: it refuses the
// unsafe inputs, prints the whole plan, changes nothing (it only reads), and keeps Starfish off the project's
// default site. And that the site it deploys to ends up linked to Starfish's web app (#156).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./deploy-web.sh", import.meta.url).pathname;

// A pnpm first on PATH that logs every call and answers only the two reads a dry run may make, from canned replies
// (`site`: the hosting:sites:get reply; `apps`: the apps:list reply; either absent = that read fails, as when the
// shell is not signed in). Anything else it is asked to do fails, and shows up in `calls`.
// `google` (#262) stands in for Google's REST APIs: gcloud then hands out a token, and curl answers a GET of the rules
// release, the ruleset or the index list with its `{ status, body }` (one absent: no response, as with no network).
function deploy(env, { site, apps, siteError, google } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pnpm-stub-"));
  const log = join(dir, "calls");
  const reply = (name, body, error) => {
    // `error`: what the CLI prints with --json when the read is refused, before it exits 1.
    if (error !== undefined) {
      writeFileSync(join(dir, `${name}.err`), error);
      return `cat "${join(dir, `${name}.err`)}"; exit 1`;
    }
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
  *"hosting:sites:get"*) ${reply("site.json", site, siteError)} ;;
  *"apps:list WEB"*) ${reply("apps.json", apps)} ;;
esac
exit 1
`,
  );
  chmodSync(join(dir, "pnpm"), 0o755);
  // gcloud and curl are stubbed too: a dry run must call neither (every call shows up in `calls`).
  writeFileSync(
    join(dir, "gcloud"),
    `#!/bin/sh\necho "gcloud $*" >> "${log}"\n${google ? `[ "$*" = "auth print-access-token" ] && echo ${TOKEN} && exit 0\n` : ""}exit 1\n`,
  );
  for (const [name, answer] of Object.entries(google ?? {})) {
    writeFileSync(join(dir, `${name}.status`), String(answer.status));
    writeFileSync(join(dir, `${name}.json`), typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {}));
  }
  // curl as the script calls it: -o <file> -w '%{http_code}' ... <url>, the token on stdin (kept, for the test to see).
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/sh
echo "curl $*" >> "${log}"
cat >> "${join(dir, "stdin")}"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|-w|-X|-d) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://firebaserules.googleapis.com/v1/projects/*/releases/cloud.firestore/*) f=release ;;
  https://firebaserules.googleapis.com/v1/projects/*/rulesets/*) f=ruleset ;;
  https://firestore.googleapis.com/v1/projects/*/databases/*/collectionGroups/-/indexes*) f=indexes ;;
  *) printf 000; exit 7 ;;
esac
[ -f "${dir}/$f.status" ] || { printf 000; exit 7; }
[ -z "$out" ] || cp "${dir}/$f.json" "$out"
cat "${dir}/$f.status"
exit 0
`,
  );
  chmodSync(join(dir, "gcloud"), 0o755);
  chmodSync(join(dir, "curl"), 0o755);
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
  const stdin = existsSync(join(dir, "stdin")) ? readFileSync(join(dir, "stdin"), "utf8") : "";
  return { ...r, out: `${r.stdout}${r.stderr}`.replace(/\\/g, ""), calls, buildEnv, stdin };
}

const TOKEN = "ya29.stub-token";
const repoRules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const RULESET = "projects/star-proj/rulesets/0a1b2c3d-4e5f";
const index = (group, state) => ({
  name: `projects/star-proj/databases/starfish/collectionGroups/${group}/indexes/CICAgI${group}`,
  state,
  fields: [{ fieldPath: "environment", order: "ASCENDING" }, { fieldPath: "updatedAt", order: "DESCENDING" }, { fieldPath: "__name__", order: "DESCENDING" }],
});
// Google's replies once the engine deploy has published this repository's rules and every index has built.
const deployed = ({ rules = repoRules, indexes = [index("starfish_cycles", "READY")] } = {}) => ({
  release: { status: 200, body: { name: "projects/star-proj/releases/cloud.firestore/starfish", rulesetName: RULESET } },
  ruleset: { status: 200, body: { name: RULESET, source: { files: [{ name: "firestore.rules", content: rules }] } } },
  indexes: { status: 200, body: { indexes } },
});

const READS = /^dlx firebase-tools@14\.27\.0 (hosting:sites:get|apps:list) /;
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
    const r = deploy(
      { PROJECT_ID: "star-proj", VITE_STARFISH_ADMIN_API_URL: "https://starfish-admin-abc-uc.a.run.app", VITE_STARFISH_STALE_MINUTES: "20" },
      { google: deployed() },
    );
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

  // A UI published ahead of its rules and indexes read "couldn't be read" on every guest tile (#262). Real (not dry) runs
  // against the stubs: the check comes before the build, so a build that ran is a check that passed.
  describe("refuses to publish a UI whose rules are not deployed (#262)", () => {
    const real = { PROJECT_ID: "star-proj" };
    const built = (r) => r.buildEnv !== undefined;

    it("reads the live release of Starfish's database, then its ruleset, and builds when it is this repository's rules", () => {
      const r = deploy(real, { google: deployed() });
      expect(built(r)).toBe(true);
      const gets = r.calls.filter((c) => c.startsWith("curl "));
      expect(gets[0]).toContain("https://firebaserules.googleapis.com/v1/projects/star-proj/releases/cloud.firestore/starfish");
      expect(gets[1]).toContain(`https://firebaserules.googleapis.com/v1/${RULESET}`);
      expect(gets[2]).toContain("https://firestore.googleapis.com/v1/projects/star-proj/databases/starfish/collectionGroups/-/indexes");
      expect(r.out).toContain("the live rules of database starfish are firestore.rules");
      expect(r.out).toContain("all 1 composite indexes are READY");
      // The token goes in on stdin, never in an argument other users of the host can list, nor in the output.
      expect(r.stdin).toContain(`Authorization: Bearer ${TOKEN}`);
      expect(r.calls.join("\n")).not.toContain(TOKEN);
      expect(r.out).not.toContain(TOKEN);
    });

    it("reads the database it is given", () => {
      const r = deploy({ ...real, STARFISH_DATABASE_ID: "ops-store" }, { google: deployed() });
      expect(built(r)).toBe(true);
      expect(r.calls.join("\n")).toContain("/releases/cloud.firestore/ops-store");
      expect(r.calls.join("\n")).toContain("/databases/ops-store/collectionGroups/-/indexes");
    });

    it("refuses a database id that is not one, before any call", () => {
      const r = deploy({ ...real, STARFISH_DATABASE_ID: "star/../x" }, { google: deployed() });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("STARFISH_DATABASE_ID must be");
      expect(r.calls).toEqual([]);
    });

    it("stops before the build when the live rules differ, and says to run the engine deploy first", () => {
      const scratch = mkdtempSync(join(tmpdir(), "deploy-web-tmp-"));
      const r = deploy({ ...real, TMPDIR: scratch }, { google: deployed({ rules: "rules_version = '2';\nservice cloud.firestore {}\n" }) });
      expect(r.status).not.toBe(0);
      // The replies it read are removed, though the refusal exits from inside the check.
      expect(readdirSync(scratch)).toEqual([]);
      expect(built(r)).toBe(false);
      expect(r.out).toContain(`the live rules of database starfish (${RULESET}) are not this repository's firestore.rules`);
      expect(r.out).toContain("run the engine deploy first (scripts/deploy-gcp.sh");
      expect(r.out).toContain("ALLOW_RULES_DRIFT=1");
      expect(r.calls.some((c) => c.includes("deploy --only hosting"))).toBe(false);
    });

    it("takes the same rules with Windows line endings as the same", () => {
      const r = deploy(real, { google: deployed({ rules: repoRules.replace(/\n/g, "\r\n") }) });
      expect(built(r)).toBe(true);
    });

    it("a database with no rules released is refused, not passed", () => {
      const r = deploy(real, { google: { ...deployed(), release: { status: 404, body: { error: { code: 404 } } } } });
      expect(r.status).not.toBe(0);
      expect(built(r)).toBe(false);
      expect(r.out).toContain("no Firestore rules are released for database starfish in star-proj");
    });

    it("says so when the live rules cannot be read, and does not pass silently", () => {
      for (const [google, says] of [
        [undefined, "no access token from gcloud"],
        [{ ...deployed(), release: { status: 403, body: {} } }, "HTTP 403"],
        [{ ...deployed(), release: undefined }, "HTTP 000"],
        [{ ...deployed(), release: { status: 200, body: { rulesetName: "../../evil" } } }, "names no ruleset"],
        [{ ...deployed(), ruleset: { status: 500, body: {} } }, "could not read the live ruleset"],
        [{ ...deployed(), ruleset: { status: 200, body: "not json" } }, "could not compare the live ruleset"],
      ]) {
        const r = deploy(real, { google: google && Object.fromEntries(Object.entries(google).filter(([, v]) => v)) });
        expect(r.status, says).not.toBe(0);
        expect(built(r), says).toBe(false);
        expect(r.out, says).toContain(says);
        expect(r.out, says).toContain("run the engine deploy first");
      }
      // Six runs of the script: about 5 s alone on a laptop, and twice that when the whole suite runs beside it, past
      // vitest's 5 s default (the same squeeze as preflight-gcp.test.mjs's two-run case).
    }, 30_000);

    it("ALLOW_RULES_DRIFT=1 deploys anyway, with a warning", () => {
      const r = deploy({ ...real, ALLOW_RULES_DRIFT: "1" }, { google: deployed({ rules: "something else" }) });
      expect(built(r)).toBe(true);
      expect(r.out).toContain("WARNING: the live rules of database starfish");
      expect(r.out).toContain("ALLOW_RULES_DRIFT=1: deploying anyway");
      const unread = deploy({ ...real, ALLOW_RULES_DRIFT: "1" });
      expect(built(unread)).toBe(true);
      expect(unread.out).toContain("WARNING: could not read the live rules");
    });

    it("warns about an index that is still building, and does not stop for it", () => {
      const r = deploy(real, {
        google: deployed({ indexes: [index("starfish_cycles", "READY"), index("starfish_public_events", "CREATING")] }),
      });
      expect(built(r)).toBe(true);
      expect(r.out).toContain("WARNING: index on starfish_public_events (environment, updatedAt) is CREATING");
      expect(r.out).not.toContain("index on starfish_cycles");
    });

    it("warns when the indexes cannot be read, and does not stop for it", () => {
      const r = deploy(real, { google: { ...deployed(), indexes: { status: 403, body: {} } } });
      expect(built(r)).toBe(true);
      expect(r.out).toContain("WARNING: could not read the indexes of database starfish (HTTP 403)");
    });

    it("a dry run prints the check and makes none of its calls", () => {
      const r = deploy(dry, { google: deployed() });
      expect(r.status).toBe(0);
      expect(onlyReads(r.calls)).toBe(true);
      expect(r.out).toContain("+ curl -H 'Authorization: Bearer <gcloud access token>' -H 'x-goog-user-project: star-proj' https://firebaserules.googleapis.com/v1/projects/star-proj/releases/cloud.firestore/starfish");
      expect(r.out).toContain("compared with firestore.rules; a difference, or a read that fails, stops the deploy here");
      expect(r.out).toContain("collectionGroups/-/indexes");
      expect(r.out.indexOf("releases/cloud.firestore/starfish")).toBeLessThan(r.out.indexOf("pnpm run build"));
      expect(deploy({ ...dry, ALLOW_RULES_DRIFT: "1" }).out).toContain("ALLOW_RULES_DRIFT=1: a difference, or a read that fails, only warns");
    });

    it("on the demo label, points at the guests' copies backfill, without running it", () => {
      const r = deploy({ ...dry, STARFISH_ENV: "demo" });
      expect(r.out).toContain("pnpm public-view -- --apply --project=star-proj");
      expect(r.calls.some((c) => c.includes("public-view"))).toBe(false);
      expect(deploy(dry).out).not.toContain("public-view");
    });
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

    // #265: the deployer had no Hosting role, the read was refused, and the script went on as if the site were missing.
    it("outside a dry run, stops on a site read refused for any reason but a 404, before touching apps or sites", () => {
      const refused = JSON.stringify({ status: "error", error: "HTTP Error: 403, The caller does not have permission" });
      const r = deploy({ PROJECT_ID: "star-proj" }, { siteError: refused, apps: appsReply, google: deployed() });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("could not read Hosting site star-proj-starfish, and the reply was not a 404");
      expect(r.out).toContain("roles/firebasehosting.admin");
      expect(r.calls.some((c) => /apps:list|apps:create|sites:create|deploy --only/.test(c))).toBe(false);
    });

    it("outside a dry run, a 404 is a missing site: it goes on to Starfish's web app", () => {
      const missing = JSON.stringify({ status: "error", error: "HTTP Error: 404, Requested entity was not found." });
      const r = deploy({ PROJECT_ID: "star-proj" }, { siteError: missing, google: deployed() });
      expect(r.status).not.toBe(0); // the stub refuses apps:list, as Actions' deployer does
      expect(r.calls.some((c) => c.includes("apps:list WEB"))).toBe(true);
      expect(r.out).toContain("create and link the site once from a terminal");
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

// #307: what Hosting serves with every page of the UI. Read from firebase.json, the file the deploy publishes with.
describe("firebase.json hosting headers", () => {
  const hosting = JSON.parse(readFileSync(new URL("../firebase.json", import.meta.url), "utf8")).hosting;
  const rule = (source) => hosting.headers.find((h) => h.source === source);
  const value = (source, key) => rule(source)?.headers.find((h) => h.key === key)?.value;

  it("sends the security headers on every path", () => {
    expect(value("**", "X-Frame-Options")).toBe("DENY");
    expect(value("**", "X-Content-Type-Options")).toBe("nosniff");
    expect(value("**", "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    const csp = value("**", "Content-Security-Policy") ?? "";
    for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) expect(csp).toContain(directive);
    // No script, connect or default source list: Firebase Auth, App Check and Firestore reach Google's hosts from the page,
    // and a list that missed one would break sign-in with nothing in the build to show it.
    expect(csp).not.toMatch(/\b(default-src|script-src|connect-src|frame-src)\b/);
  });

  it("keeps the caching rules, which Hosting applies beside the ** rule", () => {
    expect(value("/index.html", "Cache-Control")).toBe("no-cache");
    expect(value("/assets/**", "Cache-Control")).toBe("public, max-age=31536000, immutable");
    // No header is set twice for one path, so which rule wins never matters.
    const keys = (source) => rule(source).headers.map((h) => h.key);
    for (const source of ["/index.html", "/assets/**"]) for (const key of keys(source)) expect(keys("**")).not.toContain(key);
  });
});
