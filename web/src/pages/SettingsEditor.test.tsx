import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";

const mocks = vi.hoisted(() => ({ readSettings: vi.fn(), readRecentChanges: vi.fn(), saveSettings: vi.fn() }));
vi.mock("../lib/settingsWrite", async (orig) => ({
  ...(await orig<typeof import("../lib/settingsWrite")>()),
  readSettings: mocks.readSettings,
  readRecentChanges: mocks.readRecentChanges,
  saveSettings: mocks.saveSettings,
}));
vi.mock("../lib/firebase", () => ({ firestore: () => ({ db: true }) }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ settingsCollection: "starfish_settings" }) }));

import { SettingsEditor } from "./SettingsEditor";

const stored = { version: 1, revision: 2, auditId: "a-1", updatedBy: "u0", environment: "prod" };

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
  });

  it("shows overridden fields as overrides and every other field on its default", async () => {
    renderEditor();
    await screen.findByText("Runtime settings");
    expect(field("Environment label").value).toBe("prod");
    expect(field("Environment label").disabled).toBe(false);
    expect(field("Watched project").disabled).toBe(true);
    expect(screen.getAllByText("Using the engine's default.")).toHaveLength(7);
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
    await override("Model calls per cycle");
    await userEvent.type(field("Model calls per cycle"), "9");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings.mock.calls[0]![3]).toEqual({ environment: "prod", dryRun: false, modelCallBudget: 9 });
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
});
