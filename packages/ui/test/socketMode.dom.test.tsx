import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "./render.js";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient, type AppDetail } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { AppsDialog } from "../src/components/AppsDialog.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { accessibilityProblems } from "./accessibility.js";

/** Socket Mode on an app's card (J14): how it receives, its app-level token, its connections. */
const owner: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "owner",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const app = (over: Partial<AppDetail> = {}): AppDetail => ({
  id: "A_LAPTOP",
  name: "Laptop Bot",
  botUserId: "U_LAPTOP",
  createdBy: owner.id,
  createdAt: 0,
  interactivityUrl: "",
  receive: "url",
  hasAppToken: false,
  sockets: 0,
  scopes: [],
  signingSecret: "test-signing-secret-not-a-credential",
  webhooks: [],
  commands: [],
  subscriptions: [],
  ...over,
});

function appsDialog(listed: AppDetail) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: owner, users: { [owner.id]: owner }, status: "online" });
  const listApps = vi.spyOn(client.api, "listApps").mockResolvedValue({ apps: [listed] });
  const user = userEvent.setup();
  render(
    <ConfirmProvider>
      <ClientContext.Provider value={client}>
        <AppsDialog onClose={() => {}} />
      </ClientContext.Provider>
    </ConfirmProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Apps and integrations" });
  return { client, user, dialog, listApps };
}

/** The app's card, once the list has loaded. */
async function card(dialog: HTMLElement) {
  const name = await within(dialog).findByText("Laptop Bot", { selector: "span" });
  return name.closest("li")!;
}

afterEach(() => vi.restoreAllMocks());

describe("how an app receives", () => {
  it("switches an app to Socket Mode", async () => {
    const { client, user, dialog, listApps } = appsDialog(app());
    const setReceive = vi
      .spyOn(client.api, "setAppReceive")
      .mockResolvedValue({ app: app({ receive: "socket" }) });
    const shown = await card(dialog);
    const choice = within(shown).getByRole("radiogroup", { name: "How it receives" });
    expect(within(choice).getByRole("radio", { name: /At its URLs/ })).toBeChecked();

    await user.click(within(choice).getByRole("radio", { name: /Socket Mode/ }));
    expect(setReceive).toHaveBeenCalledWith("A_LAPTOP", "socket");
    expect(listApps).toHaveBeenCalledTimes(2);
  });

  it("says why it cannot go back to URLs yet", async () => {
    const { client, user, dialog } = appsDialog(app({ receive: "socket" }));
    vi.spyOn(client.api, "setAppReceive").mockRejectedValue(
      new ApiError(
        409,
        "urls_missing",
        "/deploy has no URL. Remove it, switch to URLs, then add it again with a URL.",
      ),
    );
    const shown = await card(dialog);
    await user.click(within(shown).getByRole("radio", { name: /At its URLs/ }));
    expect(await within(shown).findByRole("alert")).toHaveTextContent(
      "/deploy has no URL. Remove it, switch to URLs, then add it again with a URL.",
    );
    expect(within(shown).getByRole("radio", { name: /Socket Mode/ })).toBeChecked();
  });
});

describe("an app on Socket Mode", () => {
  it("makes an app-level token, shows it once with a copy button, and counts connections", async () => {
    const { client, user, dialog } = appsDialog(app({ receive: "socket", sockets: 2 }));
    const made = vi
      .spyOn(client.api, "replaceAppLevelToken")
      .mockResolvedValue({ token: "xapp-test-" + "a".repeat(8) });
    const shown = await card(dialog);
    expect(within(shown).getByText("2 connections open")).toBeInTheDocument();

    await user.click(within(shown).getByRole("button", { name: "Make app-level token" }));
    expect(made).toHaveBeenCalledWith("A_LAPTOP");
    expect(await within(shown).findByText("xapp-test-aaaaaaaa")).toBeInTheDocument();
    expect(within(shown).getByText(/App-level token · shown once/)).toBeInTheDocument();
    expect(within(shown).getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0);
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("asks before replacing or taking away a token it already has", async () => {
    const { client, user, dialog } = appsDialog(
      app({ receive: "socket", hasAppToken: true, sockets: 0 }),
    );
    const revoke = vi.spyOn(client.api, "revokeAppLevelToken").mockResolvedValue({ ok: true });
    const shown = await card(dialog);
    expect(within(shown).getByText("Not connected")).toBeInTheDocument();
    expect(within(shown).getByRole("button", { name: "New app-level token" })).toBeInTheDocument();

    await user.click(within(shown).getByRole("button", { name: "Take token away" }));
    const asked = await screen.findByRole("dialog", {
      name: "Take away Laptop Bot's app-level token?",
    });
    expect(asked).toHaveTextContent(/connections close/);
    await user.click(within(asked).getByRole("button", { name: "Take it away" }));
    expect(revoke).toHaveBeenCalledWith("A_LAPTOP");
  });

  it("adds commands and subscriptions without a URL, and has no button URL to set", async () => {
    const { client, user, dialog } = appsDialog(app({ receive: "socket" }));
    const createCommand = vi.spyOn(client.api, "createCommand").mockResolvedValue({
      command: {
        id: "SC1",
        appId: "A_LAPTOP",
        command: "deploy",
        url: "",
        description: "",
        usageHint: "",
        createdAt: 0,
      },
    });
    const subscribe = vi.spyOn(client.api, "createSubscription").mockResolvedValue({
      subscription: { id: "S1", appId: "A_LAPTOP", url: "", eventTypes: [], createdAt: 0 },
    });
    const shown = await card(dialog);
    expect(within(shown).queryByLabelText("Request URL")).not.toBeInTheDocument();
    expect(within(shown).getByRole("group", { name: "Interactivity" })).toHaveTextContent(
      "Button presses and forms arrive over its connection.",
    );

    const commands = within(shown).getByRole("group", { name: "Slash commands" });
    await user.type(within(commands).getByLabelText("Command"), "/deploy");
    await user.click(within(commands).getByRole("button", { name: "Add" }));
    expect(createCommand).toHaveBeenCalledWith("A_LAPTOP", {
      command: "/deploy",
      description: "",
    });

    const events = within(shown).getByRole("group", { name: "Event subscriptions" });
    await user.click(within(events).getByRole("button", { name: "Subscribe" }));
    expect(subscribe).toHaveBeenCalledWith("A_LAPTOP", { eventTypes: [] });
  });
});

describe("how this differs from Slack", () => {
  it("no longer says there is no Socket Mode", async () => {
    const { dialog } = appsDialog(app());
    await card(dialog);
    expect(dialog).not.toHaveTextContent(/no OAuth or Socket Mode/);
    expect(dialog).toHaveTextContent(/Socket Mode/);
  });
});
