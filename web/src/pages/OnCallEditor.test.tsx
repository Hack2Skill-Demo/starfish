import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
