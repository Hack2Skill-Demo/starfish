import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";
import { DEFAULT_POLICY } from "../../../src/oncallSchema";

const mocks = vi.hoisted(() => ({ readOnCall: vi.fn(), addPerson: vi.fn(), savePolicy: vi.fn(), removePerson: vi.fn(), sendOnCallCode: vi.fn(), confirmOnCallNumber: vi.fn() }));
vi.mock("../lib/onCallWrite", async (orig) => ({
  ...(await orig<typeof import("../lib/onCallWrite")>()),
  readOnCall: mocks.readOnCall,
  addPerson: mocks.addPerson,
  savePolicy: mocks.savePolicy,
  removePerson: mocks.removePerson,
}));
vi.mock("../lib/adminApi", () => ({ appAdminApi: () => ({}), sendOnCallCode: mocks.sendOnCallCode, confirmOnCallNumber: mocks.confirmOnCallNumber }));
vi.mock("../lib/firebase", () => ({ firestore: () => ({ db: true }) }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ onCallCollection: "starfish_oncall", onCallPeopleCollection: "starfish_oncall_people" }) }));

import { OnCallEditor } from "./OnCallEditor";

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
        <OnCallEditor />
      </QueryClientProvider>
    </Ctx.Provider>
  );
}

describe("OnCallEditor (#37)", () => {
  afterEach(() => {
    vi.restoreAllMocks(); // the window.confirm spies
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readOnCall.mockResolvedValue({
      policy: { ...DEFAULT_POLICY },
      people: [
        { id: "p1", name: "Ada", role: "primary", maskedPhone: "+1 ••• ••• ••42", state: "confirmed" },
        { id: "p2", name: "Grace", role: "secondary", maskedPhone: "+4 ••• ••• ••07", state: "pending" },
      ],
    });
    mocks.addPerson.mockResolvedValue("p3");
    mocks.sendOnCallCode.mockResolvedValue({ ok: true, value: null });
    mocks.confirmOnCallNumber.mockResolvedValue({ ok: true, value: null });
  });

  it("lists people with their numbers masked and their confirmation state", async () => {
    renderEditor();
    await screen.findByText("Ada");
    expect(screen.getByText("+1 ••• ••• ••42")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText("Not confirmed")).toBeInTheDocument();
    // Only an unconfirmed person can be sent a code.
    expect(screen.getAllByRole("button", { name: "Send code" })).toHaveLength(1);
  });

  it("adds a person, unconfirmed, with the number in international form", async () => {
    renderEditor();
    await screen.findByText("Ada");
    await userEvent.type(screen.getByLabelText("Name"), "Linus");
    await userEvent.type(screen.getByLabelText("Phone number"), "+1 (555) 000-0199");
    await userEvent.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(mocks.addPerson).toHaveBeenCalled());
    expect(mocks.addPerson.mock.calls[0]!.slice(2)).toEqual(["admin-uid", { name: "Linus", role: "primary", phone: "+15550000199" }]);
  });

  it("sends a code and confirms the number with it, through the admin API", async () => {
    renderEditor();
    await screen.findByText("Grace");
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));
    await waitFor(() => expect(mocks.sendOnCallCode).toHaveBeenCalledWith({}, "p2"));
    await userEvent.type(screen.getByLabelText("Code for Grace"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocks.confirmOnCallNumber).toHaveBeenCalledWith({}, "p2", "123456"));
  });

  it("refuses an invalid policy before saving it", async () => {
    renderEditor();
    await screen.findByText("Ada");
    const wait = screen.getByText("Wait before the first call (minutes)").closest("label")!.querySelector("input")!;
    await userEvent.clear(wait);
    await userEvent.type(wait, "0");
    await userEvent.click(screen.getByRole("button", { name: "Save on-call policy" }));
    expect(await screen.findByText(/Wait must be/)).toBeInTheDocument();
    expect(mocks.savePolicy).not.toHaveBeenCalled();
  });

  const waitInput = () => screen.getByText("Wait before the first call (minutes)").closest("label")!.querySelector("input")!;
  const rota = (over: { policy?: object; people?: object[] } = {}) => ({
    policy: { ...DEFAULT_POLICY },
    people: [{ id: "p1", name: "Ada", role: "primary", maskedPhone: "+1 ••• ••• ••42", state: "confirmed" }],
    ...over,
  });

  it("keeps unsaved policy edits when a person is added and the rota is read again (#358)", async () => {
    renderEditor();
    await screen.findByText("Ada");
    await userEvent.clear(waitInput());
    await userEvent.type(waitInput(), "37");
    // The refetch after the add: a new object, the same policy, one more person.
    mocks.readOnCall.mockResolvedValue(
      rota({ people: [...rota().people, { id: "p3", name: "Linus", role: "primary", maskedPhone: "+1 ••• ••• ••99", state: "pending" }] })
    );
    await userEvent.type(screen.getByLabelText("Name"), "Linus");
    await userEvent.type(screen.getByLabelText("Phone number"), "+15550000199");
    await userEvent.click(screen.getByRole("button", { name: "Add person" }));
    await screen.findByText("Linus");
    expect(waitInput()).toHaveValue("37");
  });

  it("keeps unsaved policy edits when a person is removed (#358)", async () => {
    mocks.readOnCall.mockResolvedValue(rota());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.removePerson.mockResolvedValue(undefined);
    renderEditor();
    await screen.findByText("Ada");
    await userEvent.clear(waitInput());
    await userEvent.type(waitInput(), "42");
    mocks.readOnCall.mockResolvedValue(rota({ people: [] }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText("Nobody on the rota yet.");
    expect(waitInput()).toHaveValue("42");
  });

  it("loads the stored policy again when a refetch brings a different one", async () => {
    mocks.readOnCall.mockResolvedValue(rota());
    mocks.removePerson.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderEditor();
    await screen.findByText("Ada");
    await userEvent.clear(waitInput());
    await userEvent.type(waitInput(), "42");
    // Another admin changed the policy meanwhile: the stored one wins, as before.
    mocks.readOnCall.mockResolvedValue(rota({ policy: { ...DEFAULT_POLICY, waitMinutes: 15 }, people: [] }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(waitInput()).toHaveValue("15"));
  });

  it("shows what was saved after a save, even when the refetch brings back the same policy", async () => {
    mocks.readOnCall.mockResolvedValue(rota());
    mocks.savePolicy.mockResolvedValue(undefined);
    renderEditor();
    await screen.findByText("Ada");
    await userEvent.clear(waitInput());
    await userEvent.type(waitInput(), " 20 ");
    mocks.readOnCall.mockResolvedValue(rota({ policy: { ...DEFAULT_POLICY, waitMinutes: 20 } }));
    await userEvent.click(screen.getByRole("button", { name: "Save on-call policy" }));
    await waitFor(() => expect(mocks.savePolicy).toHaveBeenCalled());
    expect(mocks.savePolicy.mock.calls[0]![3]).toMatchObject({ waitMinutes: 20 });
    await waitFor(() => expect(waitInput()).toHaveValue("20"));
  });
});
