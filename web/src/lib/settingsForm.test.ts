import { describe, expect, it } from "vitest";
import { formFromStored, settingsFromForm, type FormState } from "./settingsForm";

const defaults = formFromStored(null);
const withField = (patch: Partial<FormState>): FormState => ({ ...defaults, ...patch });

describe("formFromStored", () => {
  it("puts every field on its default when nothing is stored", () => {
    for (const field of Object.values(defaults)) expect(field).toEqual({ override: false, text: "" });
  });

  it("overrides exactly the fields the document holds, and formats lists and patterns for editing", () => {
    const form = formFromStored({
      version: 1,
      environment: "prod",
      logResourceTypes: ["cloud_function", "gae_app"],
      servicePatterns: { billing: "payments" },
      ignoredMessages: [],
      revision: 3,
    });
    expect(form.environment).toEqual({ override: true, text: "prod" });
    expect(form.logResourceTypes).toEqual({ override: true, text: "cloud_function\ngae_app" });
    expect(form.servicePatterns).toEqual({ override: true, text: "billing: payments" });
    // An empty list is an override ("suppress nothing"), not the default.
    expect(form.ignoredMessages).toEqual({ override: true, text: "" });
    expect(form.watchedProjectId.override).toBe(false);
  });
});

describe("settingsFromForm", () => {
  it("returns no settings for a form left entirely on its defaults", () => {
    expect(settingsFromForm(defaults)).toEqual({ ok: true, settings: {} });
  });

  it("builds settings from the overridden fields only", () => {
    const result = settingsFromForm(
      withField({
        watchedProjectId: { override: true, text: "  watched-app-1 " },
        logResourceTypes: { override: true, text: "cloud_function\n\n  cloud_run_revision  \n" },
        servicePatterns: { override: true, text: "Billing: payments\norders : checkout" },
        // The default stays out even though it has text typed into it.
        environment: { override: false, text: "ignored" },
      })
    );
    expect(result).toEqual({
      ok: true,
      settings: {
        watchedProjectId: "watched-app-1",
        logResourceTypes: ["cloud_function", "cloud_run_revision"],
        servicePatterns: { billing: "payments", orders: "checkout" },
      },
    });
  });

  it("an override with nothing in it is an empty noise list, but not an empty resource type list", () => {
    expect(settingsFromForm(withField({ ignoredMessages: { override: true, text: "" } }))).toEqual({
      ok: true,
      settings: { ignoredMessages: [] },
    });
    expect(settingsFromForm(withField({ logResourceTypes: { override: true, text: "" } })).ok).toBe(false);
  });

  it("explains a pattern line that isn't pattern: service", () => {
    const result = settingsFromForm(withField({ servicePatterns: { override: true, text: "ok: svc\nnonsense\n: x" } }));
    expect(result).toEqual({
      ok: false,
      problems: [
        'servicePatterns: line 2 must be "pattern: service"',
        'servicePatterns: line 3 must be "pattern: service"',
      ],
    });
  });

  it("runs the engine's own validator, and its problems never echo what was typed", () => {
    const typed = "not a project!";
    const result = settingsFromForm(
      withField({ watchedProjectId: { override: true, text: typed }, environment: { override: true, text: "bad env" } })
    );
    expect(result.ok).toBe(false);
    const problems = !result.ok ? result.problems : [];
    expect(problems.map((p) => p.split(":")[0]).sort()).toEqual(["environment", "watchedProjectId"]);
    expect(JSON.stringify(problems)).not.toContain(typed);
  });

  it("round-trips a stored document", () => {
    const stored = {
      environment: "prod",
      logResourceTypes: ["cloud_function"],
      servicePatterns: { billing: "payments" },
      ignoredMessages: ["probe"],
    };
    expect(settingsFromForm(formFromStored({ version: 1, ...stored }))).toEqual({ ok: true, settings: stored });
  });
});
