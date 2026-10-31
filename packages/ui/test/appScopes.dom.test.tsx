import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type AppDetail } from "@ownbase/client-core";
import type { EventSubscription, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { AppsDialog } from "../src/components/AppsDialog.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * What an app may do (E18c) is chosen when it is made, changed on its card,
 * and named where a subscription's events are waiting on a scope.
 */
const owner: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const app = (over: Partial<AppDetail>): AppDetail => ({
  id: "A_DEPLOY",
  name: "Deploy Bot",
  botUserId: "U_DEPLOY",
  createdBy: owner.id,
  createdAt: 0,
  interactivityUrl: "",
  signingSecret: "test-signing-secret-not-a-credential",
  webhooks: [],
  commands: [],
  subscriptions: [],
  scopes: ["chat:write"],
  ...over,
});

const subscription = (eventTypes: string[]): EventSubscription =>
  ({
    id: "S_1",
    appId: "A_DEPLOY",
    url: "https://bot.example.com/events",
    eventTypes,
    createdAt: 0,
  }) as EventSubscription;

afterEach(() => vi.restoreAllMocks());

function appsDialog(apps: AppDetail[]) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: owner, users: { [owner.id]: owner }, status: "online" });
  const listApps = vi.spyOn(client.api, "listApps").mockResolvedValue({ apps });
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <AppsDialog onClose={() => {}} />
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  return { client, listApps, user: userEvent.setup() };
}

/** The app's card, once the list has loaded. */
const card = async (name: string) =>
  (await screen.findByText(name, { selector: "span.font-medium" })).closest("li")!;

describe("what an app may do", () => {
  it("makes an app that may post and is sent nothing, unless more is ticked", async () => {
    const { client, user } = appsDialog([]);
    const createApp = vi.spyOn(client.api, "createApp").mockResolvedValue({
      app: app({ id: "A_NEW", name: "Reader" }),
      botUser: { ...owner, id: "U_NEW", isBot: true },
      token: "xoxb-test-token-not-a-credential",
      signingSecret: "test-signing-secret-not-a-credential",
    });
    const summary = screen.getByText(/^What it may do:/);
    expect(summary).toHaveTextContent("posts in any public channel, is sent no events");
    await user.click(summary);
    await user.click(screen.getByRole("checkbox", { name: "Reactions reactions:read" }));
    expect(summary).toHaveTextContent("is sent 1 of 9 kinds of event");
    await user.type(screen.getByRole("textbox", { name: "App name" }), "Reader");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(createApp).toHaveBeenCalledWith({
      name: "Reader",
      scopes: ["chat:write", "chat:write.public", "reactions:read"],
    });
  });

  it("saves an app's scopes as they are ticked, and takes back one that did not save", async () => {
    const { client, user } = appsDialog([app({})]);
    const scopes = within(await card("Deploy Bot")).getByRole("group", { name: "What it may do" });
    const setAppScopes = vi
      .spyOn(client.api, "setAppScopes")
      .mockResolvedValueOnce({ app: app({ scopes: ["chat:write", "pins:read"] }) })
      .mockRejectedValueOnce(new Error("offline"));
    // Closed to one line until opened.
    await user.click(within(scopes).getByText("Posts where it has been added, is sent no events"));
    await user.click(within(scopes).getByRole("checkbox", { name: "Pins pins:read" }));
    expect(setAppScopes).toHaveBeenCalledWith("A_DEPLOY", ["chat:write", "pins:read"]);

    const users = within(scopes).getByRole("checkbox", {
      name: "People joining, and changes to profiles users:read",
    });
    await user.click(users);
    await waitFor(() => expect(users).not.toBeChecked());
    expect(within(scopes).getByRole("alert")).toHaveTextContent("Could not change what it may do.");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });

  it("names the scopes a subscription's events are waiting on, and allows them", async () => {
    const { client, user } = appsDialog([
      app({ subscriptions: [subscription(["reaction.added", "message.created"])] }),
    ]);
    const events = within(await card("Deploy Bot")).getByRole("group", {
      name: "Event subscriptions",
    });
    // Messages come from four kinds of conversation, each its own scope.
    expect(events).toHaveTextContent(
      "Not sent without channels:history, groups:history, im:history, mpim:history, reactions:read.",
    );
    const setAppScopes = vi.spyOn(client.api, "setAppScopes").mockResolvedValue({ app: app({}) });
    await user.click(within(events).getByRole("button", { name: "Allow them" }));
    expect(setAppScopes).toHaveBeenCalledWith("A_DEPLOY", [
      "chat:write",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "reactions:read",
    ]);
  });

  it("says nothing about scopes for an app from a server before them", async () => {
    appsDialog([app({ scopes: undefined, subscriptions: [subscription([])] })]);
    const deploy = await card("Deploy Bot");
    expect(within(deploy).queryByRole("group", { name: "What it may do" })).toBeNull();
    expect(within(deploy).queryByText(/Not sent without/)).toBeNull();
  });
});
