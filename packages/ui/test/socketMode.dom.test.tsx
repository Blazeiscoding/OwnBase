import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
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
  const { unmount } = render(
    <ConfirmProvider>
      <ClientContext.Provider value={client}>
        <AppsDialog onClose={() => {}} />
      </ClientContext.Provider>
    </ConfirmProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Apps and integrations" });
  return { client, user, dialog, listApps, unmount };
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
    expect(within(choice).getByRole("radio", { name: /Request URLs/ })).toBeChecked();

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
    await user.click(within(shown).getByRole("radio", { name: /Request URLs/ }));
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
    expect(within(shown).getByText("Connected (2)")).toBeInTheDocument();

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

describe("audit X4 (2026-11-20)", () => {
  afterEach(() => vi.useRealTimers());

  it("S1: follows the connection count while a Socket Mode app is on show, and only then", async () => {
    vi.useFakeTimers();
    const { listApps, dialog, unmount } = appsDialog(app({ receive: "socket", hasAppToken: true }));
    listApps.mockResolvedValue({
      apps: [app({ receive: "socket", hasAppToken: true, sockets: 1 })],
    });
    await act(async () => {});
    const shown = within(dialog).getByText("Laptop Bot", { selector: "span" }).closest("li")!;
    expect(within(shown).getByText("Not connected")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(within(shown).getByText("Connected (1)")).toBeInTheDocument();
    expect(within(shown).getByText("Connected (1)").closest("[role=status]")).not.toBeNull();

    // A hidden window does not ask, and asks once when it is seen again.
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    const asked = listApps.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(listApps).toHaveBeenCalledTimes(asked);
    visibility.mockReturnValue("visible");
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(listApps).toHaveBeenCalledTimes(asked + 1);

    // Closing Apps stops it.
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(listApps).toHaveBeenCalledTimes(asked + 1);
  });

  it("S1: does not ask again for an app that receives at its URLs", async () => {
    vi.useFakeTimers();
    const { listApps, dialog } = appsDialog(app());
    await act(async () => {});
    expect(within(dialog).getByText("Laptop Bot", { selector: "span" })).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(listApps).toHaveBeenCalledTimes(1);
  });

  it("S2, S6: without a token, says what is needed beside a button; with one, its actions sit under the status", async () => {
    const { client, dialog } = appsDialog(app({ receive: "socket" }));
    const shown = await card(dialog);
    expect(within(shown).getByText("The app needs an app-level token to connect.")).toBeVisible();
    const make = within(shown).getByRole("button", { name: "Make app-level token" });
    expect(make.className).toContain("border");
    expect(within(shown).queryByRole("button", { name: "Take token away" })).toBeNull();

    vi.spyOn(client.api, "listApps").mockResolvedValue({
      apps: [app({ receive: "socket", hasAppToken: true })],
    });
    vi.spyOn(client.api, "replaceAppLevelToken").mockResolvedValue({
      token: "xapp-test-" + "b".repeat(8),
    });
    await userEvent.setup().click(make);
    const takeAway = await within(shown).findByRole("button", { name: "Take token away" });
    const status = within(shown).getByText("Not connected");
    // Its own row, so on a phone neither button wraps alone beside the status.
    expect(takeAway.parentElement).not.toContainElement(status);
    expect(takeAway.parentElement).toContainElement(
      within(shown).getByRole("button", { name: "New app-level token" }),
    );
  });

  it("S3, S4: says where the app-level token goes, and closing before copying names it", async () => {
    const { client, user, dialog } = appsDialog(app({ receive: "socket" }));
    vi.spyOn(client.api, "replaceAppLevelToken").mockResolvedValue({
      token: "xapp-test-" + "c".repeat(8),
    });
    const shown = await card(dialog);
    await user.click(within(shown).getByRole("button", { name: "Make app-level token" }));
    expect(await within(shown).findByText("xapp-test-cccccccc")).toBeInTheDocument();
    expect(shown).toHaveTextContent(
      "Give this to your app as SLACK_APP_TOKEN, next to its bot token (SLACK_BOT_TOKEN).",
    );

    await user.keyboard("{Escape}");
    const ask = await screen.findByRole("dialog", { name: "Close before copying?" });
    expect(ask).toHaveTextContent(
      "Bot tokens, app-level tokens and webhook addresses show only once. Copy them first if you have not already.",
    );
  });

  it("S5: shows the choice at once while it saves, and puts it back if the server refuses", async () => {
    const { client, user, dialog } = appsDialog(app());
    let answer!: (value: unknown) => void;
    vi.spyOn(client.api, "setAppReceive").mockReturnValue(
      new Promise((resolve, reject) => {
        answer = () => reject(new ApiError(500, "internal", "Something went wrong."));
      }) as ReturnType<typeof client.api.setAppReceive>,
    );
    const shown = await card(dialog);
    await user.click(within(shown).getByRole("radio", { name: /Socket Mode/ }));
    expect(within(shown).getByRole("radio", { name: /Socket Mode/ })).toBeChecked();
    expect(within(shown).getByText("Saving…")).toBeInTheDocument();

    await act(async () => answer(null));
    expect(within(shown).getByRole("radio", { name: /Request URLs/ })).toBeChecked();
    expect(within(shown).queryByText("Saving…")).toBeNull();
    expect(within(shown).getByRole("alert")).toHaveTextContent("Could not change how it receives.");
  });

  it("S7, S8: names URL delivery plainly, and the command placeholder reads as an example", async () => {
    const { dialog } = appsDialog(app());
    const shown = await card(dialog);
    expect(
      within(shown).getByRole("radio", {
        name: /^Request URLs ?The workspace posts commands, events and button presses to web addresses your app serves.$/,
      }),
    ).toBeInTheDocument();
    expect(within(shown).getByLabelText("Command")).toHaveAttribute("placeholder", "e.g. /deploy");
  });
});
