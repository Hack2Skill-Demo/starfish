import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BootstrapGate } from "./BootstrapGate";

describe("BootstrapGate", () => {
  it("renders nothing of the app until the config has resolved", async () => {
    let resolve!: () => void;
    const bootstrap = () => new Promise<void>((r) => (resolve = r));
    render(
      <BootstrapGate bootstrap={bootstrap}>
        <p>the app</p>
      </BootstrapGate>
    );
    expect(screen.queryByText("the app")).toBeNull();
    resolve();
    await waitFor(() => expect(screen.getByText("the app")).toBeInTheDocument());
  });

  it("shows why it could not start, never a blank page, and never renders the app", async () => {
    render(
      <BootstrapGate bootstrap={() => Promise.reject(new Error("/__/firebase/init.json returned 404"))}>
        <p>the app</p>
      </BootstrapGate>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("returned 404");
    expect(screen.queryByText("the app")).toBeNull();
  });
});
