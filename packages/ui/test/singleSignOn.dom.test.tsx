import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { ServerInfo, SettingsPanel, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { LinkedSignIns } from "../src/components/LinkedSignIns.js";
import { WorkspaceSettings } from "../src/components/WorkspaceSettings.js";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import type { Platform, SavedServer } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Single sign-on in the app (P9): its button on the sign-in screen, the way
 * back with a code that signs in only where it began, the owner's settings
 * for it, and linking an account to it.
 */
const URL_ = "https://acme.ownbase.chat";
const okta = {
  id: "sso",
  name: "Okta",
  start: "/api/sso/start",
  redeem: "/api/sso/redeem",
  connect: "/api/sso/connect",
};
const info = (over: Partial<ServerInfo> = {}): ServerInfo => ({
  app: "ownbase",
  protocolVersion: 1,
  serverVersion: "0.0.0-test",
  workspaceName: "Acme",
  userCount: 12,
  requiresInvite: false,
  requiresClaim: false,
  signIn: { methods: [okta], passwords: "everyone" },
  ...over,
});
const person = (role: User["role"]): User => ({
  id: "U_MAYA",
  handle: "maya",
  displayName: "Maya Lin",
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const platform = (kind: Platform["kind"]): Platform => ({
  kind,
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
});
const pending = (over: object = {}) =>
  sessionStorage.setItem(
    "ownbase-sso-pending",
    JSON.stringify({
      serverUrl: URL_,
      verifier: "the-secret-kept-here",
      redeem: "/api/sso/redeem",
      at: Date.now(),
      ...over,
    }),
  );

const clients: WorkspaceClient[] = [];
Element.prototype.scrollIntoView ??= () => {};
beforeEach(() => {
  // jsdom's crypto has no subtle; the browser's and Node's are the same API.
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function joinScreen(
  given: ServerInfo,
  opts: { kind?: Platform["kind"]; ssoCode?: string; saved?: SavedServer[] } = {},
) {
  vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(given);
  const onConnected = vi.fn();
  const shell = platform(opts.kind ?? "web");
  render(
    <PlatformContext.Provider value={shell}>
      <JoinScreen
        platform={shell}
        savedServers={opts.saved ?? []}
        autoProbe={URL_}
        ssoCode={opts.ssoCode}
        onConnected={onConnected}
        onForget={() => {}}
      />
    </PlatformContext.Provider>,
  );
  return { onConnected, user: userEvent.setup() };
}

describe("the sign-in screen with single sign-on", () => {
  it("offers its button, and keeps a secret here for the way back", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const { user } = joinScreen(info(), { kind: "desktop" });
    const button = await screen.findByRole("button", { name: "Sign in with Okta" });
    expect(screen.queryByText(/sign in only the workspace's owner/)).toBeNull();
    expect(await accessibilityProblems()).toEqual([]);
    await user.click(button);
    await waitFor(() => expect(opened).toHaveBeenCalled());
    const [url, target] = opened.mock.calls[0]!;
    expect(target).toBe("_blank");
    const start = new URL(String(url));
    expect(start.origin + start.pathname).toBe(`${URL_}/api/sso/start`);
    expect(start.searchParams.get("client")).toBe("desktop");
    const kept = JSON.parse(sessionStorage.getItem("ownbase-sso-pending")!);
    expect(kept).toMatchObject({ serverUrl: URL_, redeem: "/api/sso/redeem" });
    // What is sent is the secret's SHA-256, never the secret.
    const digest = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(kept.verifier),
    );
    expect(start.searchParams.get("challenge")).toBe(Buffer.from(digest).toString("base64url"));
    expect(start.searchParams.get("challenge")).not.toBe(kept.verifier);
    expect(screen.getByRole("status")).toHaveTextContent("Finish signing in in your browser.");
  });

  it("says passwords are the owner's alone when single sign-on is required", async () => {
    vi.spyOn(Api.prototype, "login").mockRejectedValue(
      new ApiError(
        403,
        "sso_required",
        "This workspace signs people in through its single sign-on.",
      ),
    );
    const { user } = joinScreen(info({ signIn: { methods: [okta], passwords: "owner_only" } }));
    await screen.findByRole("button", { name: "Sign in with Okta" });
    expect(screen.getByText("Passwords here sign in only the workspace's owner.")).toBeVisible();
    await user.type(screen.getByLabelText("Username"), "maya");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This workspace signs people in with its single sign-on. Use its button above.",
    );
  });

  it("shows no button where the workspace has none, or nobody to sign in yet", async () => {
    joinScreen(info({ signIn: undefined }));
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
    cleanup();
    joinScreen(info({ userCount: 0 }));
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
  });
});

describe("back from single sign-on", () => {
  it("signs in with the code and the secret kept here, once", async () => {
    pending();
    const redeem = vi.spyOn(Api.prototype, "redeemSignIn").mockResolvedValue({
      token: "session-token-from-sso",
      user: person("member"),
    });
    // Signed in here before: the new sign-in is used, not the old one.
    const me = vi.spyOn(Api.prototype, "me");
    const saved: SavedServer = {
      url: URL_,
      token: "older-token",
      workspaceName: "Acme",
      handle: "maya",
      lastUsedAt: 1,
    };
    const { onConnected } = joinScreen(info(), { ssoCode: "c".repeat(43), saved: [saved] });
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(redeem).toHaveBeenCalledWith("/api/sso/redeem", {
      code: "c".repeat(43),
      verifier: "the-secret-kept-here",
    });
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(me).not.toHaveBeenCalled();
    expect(onConnected.mock.calls[0]![0]).toMatchObject({
      url: URL_,
      token: "session-token-from-sso",
      handle: "maya",
      workspaceName: "Acme",
    });
    expect(sessionStorage.getItem("ownbase-sso-pending")).toBeNull();
  });

  it("signs nobody in with a code that did not begin here", async () => {
    const redeem = vi.spyOn(Api.prototype, "redeemSignIn");
    const { onConnected } = joinScreen(info(), { ssoCode: "d".repeat(43) });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This sign-in was not started here, or took too long.",
    );
    expect(redeem).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    cleanup();

    // Nor one begun with another workspace, or too long ago.
    pending({ serverUrl: "https://other.ownbase.chat" });
    joinScreen(info(), { ssoCode: "e".repeat(43) });
    expect(await screen.findByRole("alert")).toHaveTextContent("not started here");
    cleanup();
    pending({ at: Date.now() - 60 * 60 * 1000 });
    joinScreen(info(), { ssoCode: "f".repeat(43) });
    expect(await screen.findByRole("alert")).toHaveTextContent("not started here");
    expect(redeem).not.toHaveBeenCalled();
  });

  it("says what the server said about a code it refused", async () => {
    pending();
    vi.spyOn(Api.prototype, "redeemSignIn").mockRejectedValue(
      new ApiError(
        401,
        "sso_code_invalid",
        "That sign-in has expired, or was started somewhere else. Start again.",
      ),
    );
    joinScreen(info(), { ssoCode: "g".repeat(43) });
    expect(await screen.findByRole("alert")).toHaveTextContent("That sign-in has expired");
    expect(screen.getByRole("button", { name: "Sign in with Okta" })).toBeEnabled();
  });
});

function workspace(role: User["role"]) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: person(role),
    users: { U_MAYA: person(role) },
    status: "online",
    workspaceName: "Acme",
    workspaceSettings: true,
    accessPolicy: "account_required",
  });
  return client;
}

const panel = (over: Partial<SettingsPanel> = {}): SettingsPanel => ({
  id: "sso",
  title: "Single sign-on",
  description: "People sign in with your company's OpenID Connect provider.",
  save: "/api/sso/settings",
  status: "3 of 12 people can sign in with Okta.",
  fields: [
    { key: "name", label: "Name on the button", kind: "text", value: "Okta" },
    { key: "issuer", label: "Issuer", kind: "url", value: "https://acme.okta.com" },
    { key: "clientSecret", label: "Client secret", kind: "secret", value: "", isSet: true },
    { key: "required", label: "Require single sign-on", kind: "toggle", value: false },
  ],
  ...over,
});

describe("single sign-on in Workspace settings", () => {
  function settings(role: User["role"], panels: SettingsPanel[]) {
    const client = workspace(role);
    const read = vi.spyOn(client.api, "extensionSettings").mockResolvedValue({ panels });
    const save = vi.spyOn(client.api, "saveExtensionSettings").mockResolvedValue({ ok: true });
    render(
      <PlatformContext.Provider value={platform("web")}>
        <ClientContext.Provider value={client}>
          <ConfirmProvider>
            <WorkspaceSettings onClose={() => {}} />
          </ConfirmProvider>
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return { read, save, user: userEvent.setup() };
  }

  it("is a section of its own for the owner, saved where the server says", async () => {
    const { read, save, user } = settings("owner", [panel()]);
    await user.click(await screen.findByRole("tab", { name: "Sign-in" }));
    expect(screen.getByRole("heading", { name: "Single sign-on" })).toBeVisible();
    expect(screen.getByText("3 of 12 people can sign in with Okta.")).toBeVisible();
    const secret = screen.getByLabelText("Client secret");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAccessibleDescription(/Saved\. Leave it empty to keep it/);
    expect(await accessibilityProblems()).toEqual([]);

    await user.click(screen.getByLabelText("Require single sign-on"));
    await user.clear(screen.getByLabelText("Name on the button"));
    await user.type(screen.getByLabelText("Name on the button"), "Acme ID");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    // The secret left empty is not sent, so the one saved stays.
    expect(save).toHaveBeenCalledWith("/api/sso/settings", {
      name: "Acme ID",
      issuer: "https://acme.okta.com",
      required: true,
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("says what the server refused", async () => {
    const { save, user } = settings("owner", [
      panel({ problem: "Single sign-on needs an Enterprise license with SSO." }),
    ]);
    save.mockRejectedValue(
      new ApiError(
        400,
        "sso_discovery_failed",
        "https://acme.okta.com/.well-known/openid-configuration answered 404.",
      ),
    );
    await user.click(await screen.findByRole("tab", { name: "Sign-in" }));
    expect(screen.getByRole("note")).toHaveTextContent("needs an Enterprise license");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("answered 404");
  });

  it("is not there for an admin, or where the server adds nothing", async () => {
    const { read } = settings("admin", [panel()]);
    await screen.findByRole("tab", { name: "General" });
    expect(screen.queryByRole("tab", { name: "Sign-in" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    cleanup();
    settings("owner", []);
    await screen.findByRole("tab", { name: "General" });
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Sign-in" })).toBeNull());
  });
});

describe("linking an account in Account settings", () => {
  function linked(
    state: { connected: boolean; as?: string },
    signIn: ServerInfo["signIn"] | null = info().signIn,
  ) {
    const client = workspace("member");
    vi.spyOn(client.api, "serverInfo").mockResolvedValue(info({ signIn: signIn ?? undefined }));
    const status = vi.spyOn(client.api, "signInConnection").mockResolvedValue(state);
    const connect = vi
      .spyOn(client.api, "connectSignIn")
      .mockResolvedValue({ url: "/api/sso/start?link=one-time-link-token" });
    const disconnect = vi
      .spyOn(client.api, "disconnectSignIn")
      .mockResolvedValue({ connected: false });
    render(
      <ClientContext.Provider value={client}>
        <LinkedSignIns />
      </ClientContext.Provider>,
    );
    return { client, status, connect, disconnect, user: userEvent.setup() };
  }

  it("opens the provider in a browser to link, and says when it is linked", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const { user } = linked({ connected: false });
    await user.click(await screen.findByRole("button", { name: "Link Okta" }));
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(opened.mock.calls[0]!.slice(0, 2)).toEqual([
      "http://127.0.0.1:9/api/sso/start?link=one-time-link-token",
      "_blank",
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("Finish in the browser that opened");
  });

  it("opens nothing the server should not have sent", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const { connect, user } = linked({ connected: false });
    connect.mockResolvedValue({ url: "//evil.example/steal" });
    await user.click(await screen.findByRole("button", { name: "Link Okta" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Linking did not start.");
    expect(opened).not.toHaveBeenCalled();
  });

  it("unlinks, and says the server's reason when it will not", async () => {
    const { disconnect, user } = linked({ connected: true, as: "maya@acme.com" });
    expect(
      await screen.findByText("Linked. You can sign in with Okta as maya@acme.com."),
    ).toBeVisible();
    disconnect.mockRejectedValueOnce(
      new ApiError(
        409,
        "sso_required",
        "This workspace requires single sign-on, so your account stays linked.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Unlink" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stays linked");
    await user.click(screen.getByRole("button", { name: "Unlink" }));
    expect(await screen.findByRole("button", { name: "Link Okta" })).toBeVisible();
  });

  it("shows nothing where the workspace has no single sign-on", async () => {
    const { status } = linked({ connected: false }, null);
    await waitFor(() => expect(screen.queryByRole("heading")).toBeNull());
    expect(status).not.toHaveBeenCalled();
  });
});
