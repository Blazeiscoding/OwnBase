import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CallRelayDraft, CallRelaySetting } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const probe = vi.hoisted(() => ({ result: "works" as "works" | "refused" | "unreachable" }));
vi.mock("../src/lib/relayProbe.js", () => ({
  probeRelay: vi.fn(async () => probe.result),
}));

const { CallRelaySettings } = await import("../src/components/CallRelaySettings.js");
const { probeRelay } = await import("../src/lib/relayProbe.js");

/** A field's error line, found through the field rather than by its words. */
function problemOf(field: HTMLElement): string {
  return field.getAttribute("aria-invalid") === "true"
    ? (document.getElementById(field.getAttribute("aria-describedby")!.split(" ")[0]!)
        ?.textContent ?? "")
    : "";
}

/** The desktop app's relay bridge, keeping what it was last given. */
function fakeRelay(initial: CallRelaySetting) {
  let saved = initial;
  return {
    get: vi.fn(async () => saved),
    set: vi.fn(async (draft: CallRelayDraft) => {
      saved =
        draft.kind === "cloudflare"
          ? { kind: "cloudflare", keyId: draft.keyId }
          : draft.kind === "custom"
            ? { kind: "custom", urls: draft.urls, username: draft.username }
            : { kind: "none" };
      return saved;
    }),
    test: vi.fn(async (_draft: CallRelayDraft) => [
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" },
    ]),
  };
}

describe("the call relay in Manage hosting", () => {
  it("saves a Cloudflare key and its token, and says calls from now on can use it", async () => {
    const relay = fakeRelay({ kind: "none" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Cloudflare" }));
    await user.type(screen.getByLabelText("TURN key ID"), "4c1b5e7f9a");
    await user.type(screen.getByLabelText("API token"), "secret-token");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(relay.set).toHaveBeenCalledWith({
      kind: "cloudflare",
      keyId: "4c1b5e7f9a",
      apiToken: "secret-token",
    });
    expect(await screen.findByText("Saved. Calls that start from now on can use it.")).toBeTruthy();
    expect(screen.getByText("Relay on")).toBeTruthy();
    // The token is never shown again; the field says one is kept.
    expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("API token").getAttribute("placeholder")).toMatch(/Saved/);
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("leaves a saved password out of what it sends, so the one kept is used", async () => {
    const relay = fakeRelay({
      kind: "custom",
      urls: ["turn:relay.example.org:3478"],
      username: "workspace",
    });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    const addresses = await screen.findByLabelText("Addresses, one per line");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.type(addresses, "\nturns:relay.example.org:5349");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(relay.set).toHaveBeenCalledWith({
      kind: "custom",
      urls: ["turn:relay.example.org:3478", "turns:relay.example.org:5349"],
      username: "workspace",
    });
  });

  it("checks the relay gives a route, and says what went wrong when it does not", async () => {
    const relay = fakeRelay({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Test" }));
    expect(relay.test).toHaveBeenCalledWith({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    expect(probeRelay).toHaveBeenCalledWith([
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" },
    ]);
    expect(
      await screen.findByText("The relay works: this computer reached it and got a route."),
    ).toBeTruthy();

    probe.result = "refused";
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("The relay refused the username or password.")).toBeTruthy();

    relay.test.mockRejectedValueOnce(
      new Error("Cloudflare refused the API token for this TURN key."),
    );
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(
      await screen.findByText("Cloudflare refused the API token for this TURN key."),
    ).toBeTruthy();
  });

  it("shows why the relay is not working when calls found out", async () => {
    const relay = fakeRelay({
      kind: "cloudflare",
      keyId: "4c1b5e7f9a",
      error: "Cloudflare refused the API token for this TURN key.",
    });
    render(<CallRelaySettings relay={relay} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Cloudflare refused the API token for this TURN key.",
    );
  });

  it("says what is missing beside each field, and goes to the first, before sending", async () => {
    const relay = fakeRelay({ kind: "none" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Cloudflare" }));
    const keyId = screen.getByLabelText("TURN key ID");
    const token = screen.getByLabelText("API token");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-disabled");

    await user.click(save);
    expect(relay.set).not.toHaveBeenCalled();
    expect(keyId).toHaveFocus();
    expect(problemOf(keyId)).toBe("Enter the TURN key ID.");
    expect(problemOf(token)).toBe("Enter the TURN key's API token.");
    expect(await accessibilityProblems()).toEqual([]);

    // Test checks the same, rather than asking the app about half a relay.
    await user.type(keyId, "key with spaces");
    expect(keyId).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(relay.test).not.toHaveBeenCalled();
    expect(keyId).toHaveFocus();
    expect(problemOf(keyId)).toBe(
      "A TURN key ID has only letters, digits, hyphens and underscores.",
    );

    await user.clear(keyId);
    await user.type(keyId, "4c1b5e7f9a");
    await user.click(save);
    expect(token).toHaveFocus();
    expect(problemOf(keyId)).toBe("");
    await user.type(token, "secret-token{Enter}");
    expect(relay.set).toHaveBeenCalledWith({
      kind: "cloudflare",
      keyId: "4c1b5e7f9a",
      apiToken: "secret-token",
    });
  });

  it("asks for a relay's address, username and password, and checks the address", async () => {
    const relay = fakeRelay({ kind: "none" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Another TURN server" }));
    const addresses = screen.getByLabelText("Addresses, one per line");
    const username = screen.getByLabelText("Username");
    const password = screen.getByLabelText("Password");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(addresses).toHaveFocus();
    expect(problemOf(addresses)).toBe("Enter the relay's address.");
    expect(problemOf(username)).toBe("Enter the relay's username.");
    expect(problemOf(password)).toBe("Enter the relay's password.");
    expect(await accessibilityProblems()).toEqual([]);

    await user.type(addresses, "relay.example.org:3478");
    await user.type(username, "workspace");
    await user.type(password, "relay-password");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(addresses).toHaveFocus();
    expect(problemOf(addresses)).toBe(
      "A relay address starts with turn: or turns:, like turn:relay.example.org:3478.",
    );
    expect(problemOf(username)).toBe("");
    expect(relay.set).not.toHaveBeenCalled();

    await user.clear(addresses);
    await user.type(addresses, "turn:relay.example.org:3478");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(relay.set).toHaveBeenCalledWith({
      kind: "custom",
      urls: ["turn:relay.example.org:3478"],
      username: "workspace",
      credential: "relay-password",
    });
  });

  it("saves the same relay again when nothing changed, and says it did", async () => {
    const relay = fakeRelay({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await screen.findByText("Relay on");
    // The saved token is kept, so an empty token field is nothing missing.
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(relay.set).toHaveBeenCalledWith({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    expect(
      await screen.findByText("Saved. Calls that start from now on can use it."),
    ).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a refusal under the field it is about, and one about no field under the buttons", async () => {
    const relay = fakeRelay({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    const test = await screen.findByRole("button", { name: "Test" });
    const token = screen.getByLabelText("API token");

    relay.test.mockRejectedValueOnce(
      new Error("Cloudflare refused the API token for this TURN key."),
    );
    await user.click(test);
    expect(
      await screen.findByText("Cloudflare refused the API token for this TURN key."),
    ).toBeTruthy();
    expect(token).toHaveFocus();
    expect(problemOf(token)).toBe("Cloudflare refused the API token for this TURN key.");

    relay.set.mockRejectedValueOnce(
      new Error(
        "Tandem cannot keep the relay's secret safe: this computer's credential protection is unavailable. Unlock your system key store and try again.",
      ),
    );
    await user.type(token, "another-token");
    expect(token).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /cannot keep the relay's secret safe/,
    );
    expect(token).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("TURN key ID")).not.toHaveAttribute("aria-invalid");
  });

  it("turns the relay off", async () => {
    const relay = fakeRelay({ kind: "cloudflare", keyId: "4c1b5e7f9a" });
    render(<CallRelaySettings relay={relay} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "No relay" }));
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(relay.set).toHaveBeenCalledWith({ kind: "none" });
    await waitFor(() => expect(screen.queryByText("Relay on")).toBeNull());
  });
});
