import { describe, expect, it } from "vitest";
import { formFromStored, settingsFromForm, type FormState } from "./settingsForm";

const defaults = formFromStored(null);
const withField = (patch: Partial<FormState>): FormState => ({ ...defaults, ...patch });

describe("formFromStored", () => {
  it("puts every field on its default when nothing is stored", () => {
    for (const field of Object.values(defaults)) expect(field.override).toBe(false);
    // A switch that gets overridden starts On, the safe side.
    expect(defaults.dryRun.text).toBe("true");
    expect(defaults.reviewRequired.text).toBe("true");
    expect(defaults.automationEnabled.text).toBe("true");
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

describe("pipeline switches", () => {
  it("shows a stored switch and budget as an override", () => {
    const form = formFromStored({ version: 1, dryRun: false, reviewRequired: true, automationEnabled: false, modelCallBudget: 12 });
    expect(form.automationEnabled).toEqual({ override: true, text: "false" });
    expect(form.dryRun).toEqual({ override: true, text: "false" });
    expect(form.reviewRequired).toEqual({ override: true, text: "true" });
    expect(form.modelCallBudget).toEqual({ override: true, text: "12" });
  });

  it("sends real booleans and a real number, only for the overridden fields", () => {
    expect(
      settingsFromForm(
        withField({
          dryRun: { override: true, text: "false" },
          reviewRequired: { override: false, text: "false" },
          modelCallBudget: { override: true, text: " 8 " },
        })
      )
    ).toEqual({ ok: true, settings: { dryRun: false, modelCallBudget: 8 } });
  });

  it("refuses an empty, fractional or out-of-range budget instead of guessing", () => {
    for (const text of ["", "  ", "0", "51", "2.5", "abc"]) {
      const result = settingsFromForm(withField({ modelCallBudget: { override: true, text } }));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.problems.map((p) => p.split(":")[0])).toEqual(["modelCallBudget"]);
    }
  });

  it("round-trips a stored pipeline document", () => {
    const stored = { dryRun: false, reviewRequired: false, automationEnabled: false, modelCallBudget: 3 };
    expect(settingsFromForm(formFromStored({ version: 1, ...stored }))).toEqual({ ok: true, settings: stored });
  });
});

describe("the Gemini model and region (#7)", () => {
  it("round-trips a stored model and region, trimming what was typed", () => {
    const form = formFromStored({ version: 1, model: "gemini-3.1-pro-preview", location: "global" });
    expect(form.model).toEqual({ override: true, text: "gemini-3.1-pro-preview" });
    expect(form.location).toEqual({ override: true, text: "global" });
    expect(
      settingsFromForm(withField({ model: { override: true, text: " gemini-x " }, location: { override: true, text: "europe-west4 " } }))
    ).toEqual({ ok: true, settings: { model: "gemini-x", location: "europe-west4" } });
  });

  it("refuses an empty or malformed model or region with the engine's own validator", () => {
    for (const text of ["", "Gemini", "a/b"]) {
      const result = settingsFromForm(withField({ model: { override: true, text } }));
      expect(!result.ok && result.problems.map((p) => p.split(":")[0])).toEqual(["model"]);
    }
    for (const text of ["", "us central1", "us-central1.example.com"]) {
      const result = settingsFromForm(withField({ location: { override: true, text } }));
      expect(!result.ok && result.problems.map((p) => p.split(":")[0])).toEqual(["location"]);
    }
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
