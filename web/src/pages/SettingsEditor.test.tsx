import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  readRecentChanges: vi.fn(),
  saveSettings: vi.fn(),
  readPublicSettings: vi.fn(),
}));
vi.mock("../lib/settingsWrite", async (orig) => ({
  ...(await orig<typeof import("../lib/settingsWrite")>()),
  readSettings: mocks.readSettings,
  readRecentChanges: mocks.readRecentChanges,
  saveSettings: mocks.saveSettings,
  readPublicSettings: mocks.readPublicSettings,
}));
vi.mock("../lib/firebase", () => ({ firestore: () => ({ db: true }) }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ settingsCollection: "starfish_settings" }) }));

import { SettingsEditor, SettingsReadOnly } from "./SettingsEditor";

const stored = { version: 1, revision: 2, auditId: "a-1", updatedBy: "u0", environment: "prod" };
/** The copy operators and guests read, as the save that wrote `stored` left it. */
const copy = { environment: "prod", revision: 2, settings: { environment: "prod" } };

function renderEditor() {
  const ctx: StarfishAuthCtx = {
    user: { uid: "admin-uid" } as StarfishAuthCtx["user"],
    roles: ["admin"],
    role: "admin",
    loading: false,
    signOut: async () => {},
    guest: false,
    enterAsGuest: async () => false,
  };
  return render(
    <Ctx.Provider value={ctx}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SettingsEditor />
      </QueryClientProvider>
    </Ctx.Provider>
  );
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
const override = (label: string) =>
  userEvent.click(screen.getByText(label).closest("fieldset")!.querySelector("input[type=checkbox]")!);

describe("SettingsEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSettings.mockResolvedValue(stored);
    mocks.readRecentChanges.mockResolvedValue([]);
    mocks.saveSettings.mockResolvedValue(undefined);
    mocks.readPublicSettings.mockResolvedValue(copy);
  });

  it("shows overridden fields as overrides and every other field on its default", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    expect(field("Environment label").value).toBe("prod");
    expect(field("Environment label").disabled).toBe(false);
    expect(field("Watched project").disabled).toBe(true);
    expect(screen.getAllByText("Using the engine's default.")).toHaveLength(15);
    expect(screen.getByText("Revision 2")).toBeInTheDocument();
  });

  it("saves nothing until something changes", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("saves the changed settings as the next revision of what it read", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    await override("Watched project");
    await userEvent.type(field("Watched project"), "watched-app-1");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    const [, cols, uid, settings, prev] = mocks.saveSettings.mock.calls[0]!;
    expect(cols).toEqual({
      settings: "starfish_settings",
      public: "starfish_settings_public",
      audit: "starfish_settings_audit",
    });
    expect(uid).toBe("admin-uid");
    expect(settings).toEqual({ environment: "prod", watchedProjectId: "watched-app-1" });
    expect(prev).toBe(stored);
  });

  it("edits the pipeline switches: a select for each switch, a number for the budget", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    expect(field("Dry run").disabled).toBe(true);
    await override("Dry run");
    await userEvent.selectOptions(field("Dry run"), "false");
    await override("Automation");
    await userEvent.selectOptions(field("Automation"), "false");
    await override("Model calls per cycle");
    await userEvent.type(field("Model calls per cycle"), "9");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings.mock.calls[0]![3]).toEqual({
      environment: "prod",
      dryRun: false,
      automationEnabled: false,
      modelCallBudget: 9,
    });
  });

  it("edits the Gemini model and Vertex AI region (#7)", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    expect(field("Gemini model").disabled).toBe(true);
    await override("Gemini model");
    await userEvent.type(field("Gemini model"), "gemini-2.5-flash");
    await override("Vertex AI region");
    await userEvent.type(field("Vertex AI region"), "europe-west4");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings.mock.calls[0]![3]).toEqual({
      environment: "prod",
      model: "gemini-2.5-flash",
      location: "europe-west4",
    });
  });

  it("edits the Vertex AI project (#7)", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    expect(field("Vertex AI project").disabled).toBe(true);
    await override("Vertex AI project");
    await userEvent.type(field("Vertex AI project"), "my-ai-project");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings.mock.calls[0]![3]).toEqual({ environment: "prod", vertexProjectId: "my-ai-project" });
  });

  it("refuses a region that isn't one without saving", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    await override("Vertex AI region");
    await userEvent.type(field("Vertex AI region"), "us-central1.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("location:");
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range budget without saving", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    await override("Model calls per cycle");
    await userEvent.type(field("Model calls per cycle"), "99");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("modelCallBudget:");
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("refuses to save an invalid value, and says which field and rule without echoing it", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    await userEvent.clear(field("Environment label"));
    await userEvent.type(field("Environment label"), "bad env!");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("environment:");
    expect(screen.getByRole("alert")).not.toHaveTextContent("bad env!");
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("an override with nothing in it saves an empty noise list", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    await override("Ignored messages");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalled());
    expect(mocks.saveSettings.mock.calls[0]![3]).toEqual({ environment: "prod", ignoredMessages: [] });
  });

  it("after a refused save (a stale tab), says so and reloads what another admin saved", async () => {
    mocks.saveSettings.mockRejectedValue(Object.assign(new Error("denied"), { code: "permission-denied" }));
    renderEditor();
    await screen.findByText("Runtime settings");
    await userEvent.clear(field("Environment label"));
    await userEvent.type(field("Environment label"), "staging");
    mocks.readSettings.mockResolvedValue({ ...stored, revision: 3, environment: "other-admin" });
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(document.body).toHaveTextContent("Not saved: the settings changed since you opened"));
    await waitFor(() => expect(field("Environment label").value).toBe("other-admin"));
    expect(screen.getByText("Revision 3")).toBeInTheDocument();
  });

  it("a refused save that finds the stored settings unchanged still discards the edits it said it reloaded over", async () => {
    mocks.saveSettings.mockRejectedValue(Object.assign(new Error("denied"), { code: "permission-denied" }));
    renderEditor();
    await screen.findByText("Runtime settings");
    await userEvent.clear(field("Environment label"));
    await userEvent.type(field("Environment label"), "staging");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(field("Environment label").value).toBe("prod"));
  });

  it("a failed write that isn't a refusal keeps the edits, so the admin can try again", async () => {
    mocks.saveSettings.mockRejectedValue(Object.assign(new Error("offline"), { code: "unavailable" }));
    renderEditor();
    await screen.findByText("Runtime settings");
    await userEvent.clear(field("Environment label"));
    await userEvent.type(field("Environment label"), "staging");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(document.body).toHaveTextContent("Not saved: the write failed"));
    expect(field("Environment label").value).toBe("staging");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  });

  it("resets to the defaults only after confirmation, by saving an empty document", async () => {
    const confirm = vi.spyOn(window, "confirm");
    renderEditor();
    await screen.findByText("Runtime settings");

    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(mocks.saveSettings).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings.mock.calls[0]![3]).toEqual({});
  });

  it("lists recent changes with who, when and what", async () => {
    mocks.readRecentChanges.mockResolvedValue([
      { id: "x", revision: 2, by: "u0", at: new Date("2026-10-04T12:00:00Z"), changed: ["environment", "ignoredMessages"] },
      { id: "y", revision: 1, by: "u1", at: null, changed: [] },
    ]);
    renderEditor();
    expect(await screen.findByText("changed environment, ignoredMessages")).toBeInTheDocument();
    expect(screen.getByText("by u0")).toBeInTheDocument();
    expect(screen.getByText("saved with no change")).toBeInTheDocument();
  });

  it("says so when the settings can't be read, instead of showing an empty form", async () => {
    mocks.readSettings.mockRejectedValue(new Error("permission-denied"));
    renderEditor();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read the settings");
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  });

  it("offers a save with nothing changed when the read-only copy was written before it carried the settings", async () => {
    mocks.readPublicSettings.mockResolvedValue({ environment: "prod", revision: 2 });
    renderEditor();
    expect(await screen.findByText(/doesn't show these settings yet/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save settings" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings.mock.calls[0]![3]).toEqual({ environment: "prod" });
  });

  it("asks for no such save when nothing is stored: there is nothing for the copy to show", async () => {
    mocks.readSettings.mockResolvedValue(null);
    mocks.readPublicSettings.mockResolvedValue(null);
    renderEditor();
    await screen.findByText("Runtime settings");
    await waitFor(() => expect(mocks.readPublicSettings).toHaveBeenCalled());
    expect(screen.queryByText(/doesn't show these settings yet/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });
});

describe("SettingsReadOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderReadOnly = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SettingsReadOnly note="Read-only: only an admin can change these." />
      </QueryClientProvider>
    );

  it("shows the settings in force as text, from the copy, with no control to change them", async () => {
    mocks.readPublicSettings.mockResolvedValue({
      environment: "demo",
      revision: 4,
      settings: {
        environment: "demo",
        dryRun: false,
        autoMerge: true,
        ignoredMessages: [],
        servicePatterns: { billing: "payments" },
        modelCallBudget: 9,
      },
    });
    const { container } = renderReadOnly();
    expect(await screen.findByText("Revision 4")).toBeInTheDocument();
    const value = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling!;
    expect(value("Environment label")).toHaveTextContent("demo");
    expect(value("Dry run")).toHaveTextContent(/Off$/);
    expect(value("Auto-merge")).toHaveTextContent(/On$/);
    expect(value("Ignored messages")).toHaveTextContent("Overridden with nothing in it.");
    expect(value("Service patterns")).toHaveTextContent("billing: payments");
    expect(value("Model calls per cycle")).toHaveTextContent(/9$/);
    expect(value("Watched project")).toHaveTextContent("Using the engine's default.");
    expect(screen.getAllByText("Using the engine's default.")).toHaveLength(10);
    expect(screen.getByRole("note")).toHaveTextContent("only an admin can change these");
    // Nothing to edit, save or reset; and it never reads the admins' own document or history.
    expect(container.querySelector("input, select, textarea, form, button")).toBeNull();
    expect(mocks.readSettings).not.toHaveBeenCalled();
    expect(mocks.readRecentChanges).not.toHaveBeenCalled();
  });

  it("with no copy at all (nothing ever saved), shows every field on the engine's default", async () => {
    mocks.readPublicSettings.mockResolvedValue(null);
    renderReadOnly();
    expect(await screen.findAllByText("Using the engine's default.")).toHaveLength(16);
  });

  it("never guesses from a copy written before it carried the settings", async () => {
    mocks.readPublicSettings.mockResolvedValue({ environment: "demo", revision: 3 });
    renderReadOnly();
    expect(await screen.findByText(/aren't shown here yet/)).toBeInTheDocument();
    expect(screen.queryByText("Using the engine's default.")).toBeNull();
  });

  it("says so when the copy can't be read", async () => {
    mocks.readPublicSettings.mockRejectedValue(new Error("permission-denied"));
    renderReadOnly();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read the settings");
    expect(screen.queryByText("Using the engine's default.")).toBeNull();
  });
});
