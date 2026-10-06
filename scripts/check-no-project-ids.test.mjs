import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./check-no-project-ids.mjs";

const texts = (src) => scan(src).map((f) => f.text);

describe("check-no-project-ids", () => {
  it("finds hosted domains of a real-looking project, in any of the Firebase and Cloud Run shapes", () => {
    expect(texts("const u = 'https://acme-prod-4821.web.app/x';")).toEqual(['hosted domain "acme-prod-4821.web.app"']);
    expect(texts("acme-prod.firebaseapp.com")).toHaveLength(1);
    expect(texts("acme-prod.appspot.com")).toHaveLength(1);
    expect(texts("us-central1-acme-prod.cloudfunctions.net")).toHaveLength(1);
    expect(texts("https://admin-api-xyz-uc.a.run.app/api")).toEqual(['hosted domain "admin-api-xyz-uc.a.run.app"']);
  });

  it("finds a project id given to a flag, an env assignment, a resource path or a quoted property", () => {
    expect(texts("gcloud run jobs list --project acme-prod-4821")).toEqual(['project id "acme-prod-4821"']);
    expect(texts("--project=acme-prod-4821")).toHaveLength(1);
    expect(texts("PROJECT_ID=acme-prod-4821 scripts/deploy-gcp.sh")).toHaveLength(1);
    expect(texts("GOOGLE_CLOUD_PROJECT='acme-prod-4821'")).toHaveLength(1);
    expect(texts("name: `projects/acme-prod-4821/databases/(default)`")).toHaveLength(1);
    expect(texts('initializeApp({ projectId: "acme-prod-4821" })')).toHaveLength(1);
    expect(texts("new GoogleGenAI({ project: 'acme-prod-4821' })")).toHaveLength(1);
  });

  it("finds the hosting organisation's name in any case", () => {
    expect(texts("see github.com/Hack2Skill-Demo/starfish")).toEqual(['organisation name "Hack2Skill"']);
  });

  it("passes placeholders, demo- emulator projects, and variables", () => {
    expect(scan("PROJECT_ID=my-project scripts/deploy-gcp.sh")).toEqual([]);
    expect(scan("https://my-site.web.app")).toEqual([]);
    expect(scan("--project demo-starfish-rules")).toEqual([]);
    expect(scan('--project "$PROJECT_ID" --project ${PROJECT_ID} projects/${id}/x --project <id>')).toEqual([]);
    expect(scan("initializeApp({ projectId: config.projectId })")).toEqual([]);
    // Prose is not a flag value: an id is 6-30 characters.
    expect(scan("refuses if the --project is wrong")).toEqual([]);
  });

  it("reports the line of each finding", () => {
    expect(scan("ok\n\nx --project acme-prod-4821")).toEqual([{ line: 3, text: 'project id "acme-prod-4821"' }]);
  });

  it("passes on the repository as it stands", () => {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-no-project-ids.mjs");
    expect(() => execFileSync(process.execPath, [script], { stdio: "pipe" })).not.toThrow();
  });
});
