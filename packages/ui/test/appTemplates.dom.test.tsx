import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient, type AppDetail } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { AppsDialog } from "../src/components/AppsDialog.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { CI_TEST_MESSAGE, WEBHOOK_EXAMPLE, curlExample } from "../src/lib/appTemplates.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Apps and integrations starts from outcomes (UX-63): a template sets up a
 * webhook or a command in a click or two, gives an example ready to copy, and
 * proves it with a test, without anyone reading how this differs from Slack.
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

const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: owner.id,
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const builds = room("C_BUILDS", "builds");

const SECRET = "test-signing-secret-not-a-credential";
const app = (over: Partial<AppDetail>): AppDetail => ({
  id: "A_HOOK",
  name: "Webhook",
  botUserId: "U_HOOK",
  createdBy: owner.id,
  createdAt: 0,
  interactivityUrl: "",
  signingSecret: SECRET,
  webhooks: [],
  commands: [],
  subscriptions: [],
  ...over,
});
const HOOK_PATH = "/hooks/test-webhook-not-a-credential";
/** An example as Testing Library reads it: its lines and indents run together. */
const asRead = (code: string) => code.replace(/\s+/g, " ").trim();

function appsDialog(apps: AppDetail[] = []) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner },
    channels: { [builds.id]: builds, [general.id]: general },
    status: "online",
  });
  const listApps = vi.spyOn(client.api, "listApps").mockResolvedValue({ apps });
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <AppsDialog onClose={() => {}} />
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Apps and integrations" });
  return { client, user, dialog, listApps };
}

/** What the server answers when a template makes its app. */
function makesApp(client: WorkspaceClient, made: AppDetail) {
  return vi.spyOn(client.api, "createApp").mockResolvedValue({
    app: {
      id: made.id,
      name: made.name,
      botUserId: made.botUserId,
      createdBy: made.createdBy,
      createdAt: made.createdAt,
      interactivityUrl: "",
    },
    botUser: { ...owner, id: made.botUserId, handle: "webhook-bot", isBot: true },
    token: "test-bot-token-not-a-credential",
    signingSecret: made.signingSecret,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Apps and integrations' templates", () => {
  it("posts a test message through a new webhook without opening the notes on Slack", async () => {
    const { client, user, dialog, listApps } = appsDialog();
    const createApp = makesApp(client, app({}));
    const createWebhook = vi.spyOn(client.api, "createWebhook").mockResolvedValue({
      webhook: { id: "W_1", appId: "A_HOOK", channelId: general.id, createdAt: 0 },
      url: HOOK_PATH,
    });
    const postToWebhook = vi.spyOn(client.api, "postToWebhook").mockResolvedValue();
    await within(dialog).findByText(/No apps yet/);

    // It opens on the first template, with the notes on Slack folded away.
    const templates = within(dialog).getByRole("tablist", { name: "Templates" });
    expect(within(templates).getByRole("tab", { name: "Incoming webhook" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const panel = within(dialog).getByRole("tabpanel", { name: "Incoming webhook" });
    const notes = within(dialog).getByText("How this differs from Slack").closest("details")!;
    expect(notes.open).toBe(false);
    expect(within(panel).getByLabelText("Channel")).toHaveDisplayValue("#general");
    expect(within(panel).getByLabelText("Post as")).toHaveDisplayValue("A new app");
    expect(within(panel).getByLabelText("New app name")).toHaveValue("Webhook");
    // Before there is a URL, the example says where it will go.
    expect(within(panel).getByText(/hooks\/…/)).toBeVisible();
    expect(within(panel).queryByRole("button", { name: "Send test message" })).toBeNull();

    listApps.mockResolvedValue({
      apps: [
        app({ webhooks: [{ id: "W_1", appId: "A_HOOK", channelId: general.id, createdAt: 0 }] }),
      ],
    });
    await user.click(within(panel).getByRole("button", { name: "Create webhook" }));
    // A template's app may post, and is sent nothing until more is allowed (E18c).
    expect(createApp).toHaveBeenCalledWith({
      name: "Webhook",
      scopes: ["chat:write", "chat:write.public"],
    });
    expect(createWebhook).toHaveBeenCalledWith("A_HOOK", { channelId: general.id });
    const url = `http://127.0.0.1:9${HOOK_PATH}`;
    expect(await within(panel).findByText(asRead(curlExample(url)))).toBeVisible();
    expect(within(panel).getByLabelText("Post as")).toHaveDisplayValue("Webhook");
    expect(within(panel).queryByRole("button", { name: "Create webhook" })).toBeNull();

    // The example copies whole, and says so.
    await user.click(within(panel).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(curlExample(url));
    expect(await screen.findByText("Example with curl copied.")).toBeVisible();

    await user.click(within(panel).getByRole("button", { name: "Send test message" }));
    expect(postToWebhook).toHaveBeenCalledWith(url, WEBHOOK_EXAMPLE);
    expect(within(panel).getByRole("status")).toHaveTextContent("Posted to #general.");

    // The app it made is listed below, with the token it shows only once.
    expect(within(dialog).getByText(/Bot token · shown once/)).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("has the CI step ready with the URL a webhook template already made", async () => {
    const { client, user, dialog, listApps } = appsDialog();
    makesApp(client, app({ name: "CI" }));
    vi.spyOn(client.api, "createWebhook").mockResolvedValue({
      webhook: { id: "W_1", appId: "A_HOOK", channelId: builds.id, createdAt: 0 },
      url: HOOK_PATH,
    });
    const postToWebhook = vi.spyOn(client.api, "postToWebhook").mockResolvedValue();
    await within(dialog).findByText(/No apps yet/);

    await user.click(within(dialog).getByRole("tab", { name: "Post CI results" }));
    let panel = within(dialog).getByRole("tabpanel", { name: "Post CI results" });
    expect(within(panel).getByLabelText("New app name")).toHaveValue("CI");
    await user.selectOptions(within(panel).getByLabelText("Channel"), "#builds");
    listApps.mockResolvedValue({
      apps: [
        app({
          name: "CI",
          webhooks: [{ id: "W_1", appId: "A_HOOK", channelId: builds.id, createdAt: 0 }],
        }),
      ],
    });
    await user.click(within(panel).getByRole("button", { name: "Create webhook" }));
    const url = `http://127.0.0.1:9${HOOK_PATH}`;
    expect(await within(panel).findByText(url)).toBeVisible();
    expect(panel).toHaveTextContent("Save it in the repository’s secrets as OWNBASE_WEBHOOK_URL.");
    expect(within(panel).getByText(/secrets\.OWNBASE_WEBHOOK_URL/)).toBeVisible();

    // Away and back, once the list has the webhook: the URL is still there,
    // because the choice is shared.
    await within(dialog).findByText("#builds", { selector: "span" });
    await user.click(within(dialog).getByRole("tab", { name: "Incoming webhook" }));
    panel = within(dialog).getByRole("tabpanel", { name: "Incoming webhook" });
    expect(within(panel).getByText(asRead(curlExample(url)))).toBeVisible();
    await user.click(within(dialog).getByRole("tab", { name: "Post CI results" }));
    panel = within(dialog).getByRole("tabpanel", { name: "Post CI results" });

    await user.click(within(panel).getByRole("button", { name: "Send test message" }));
    expect(postToWebhook).toHaveBeenCalledWith(url, CI_TEST_MESSAGE);
    expect(within(panel).getByRole("status")).toHaveTextContent("Posted to #builds.");
  });

  it("says what to do when the test does not arrive", async () => {
    const { client, user, dialog, listApps } = appsDialog();
    makesApp(client, app({}));
    vi.spyOn(client.api, "createWebhook").mockResolvedValue({
      webhook: { id: "W_1", appId: "A_HOOK", channelId: general.id, createdAt: 0 },
      url: HOOK_PATH,
    });
    const postToWebhook = vi
      .spyOn(client.api, "postToWebhook")
      .mockRejectedValueOnce(new ApiError(404, "invalid_webhook"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await within(dialog).findByText(/No apps yet/);
    const panel = within(dialog).getByRole("tabpanel", { name: "Incoming webhook" });
    listApps.mockResolvedValue({ apps: [app({})] });
    await user.click(within(panel).getByRole("button", { name: "Create webhook" }));

    const send = await within(panel).findByRole("button", { name: "Send test message" });
    await user.click(send);
    expect(within(panel).getByRole("status")).toHaveTextContent(
      "This URL no longer works: it was replaced or removed. Create the webhook again.",
    );
    await user.click(send);
    expect(within(panel).getByRole("status")).toHaveTextContent(
      "Could not reach the workspace at this URL.",
    );
    expect(postToWebhook).toHaveBeenCalledTimes(2);
  });

  it("asks for a name before making an app, instead of a button that does nothing", async () => {
    const { client, user, dialog } = appsDialog();
    const createApp = makesApp(client, app({}));
    await within(dialog).findByText(/No apps yet/);
    const panel = within(dialog).getByRole("tabpanel", { name: "Incoming webhook" });
    await user.clear(within(panel).getByLabelText("New app name"));
    await user.click(within(panel).getByRole("button", { name: "Create webhook" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent("Name the new app first.");
    expect(createApp).not.toHaveBeenCalled();
  });

  it("adds a slash command to an app that has one, with its secret, and runs it as a test", async () => {
    const deploy = app({ id: "A_DEPLOY", name: "Deploy Bot", botUserId: "U_DEPLOY" });
    const { client, user, dialog, listApps } = appsDialog([deploy]);
    await within(dialog).findByText("Deploy Bot", { selector: "span" });
    await user.click(within(dialog).getByRole("tab", { name: "Slash command" }));
    const panel = within(dialog).getByRole("tabpanel", { name: "Slash command" });
    expect(within(panel).getByLabelText("New app name")).toHaveValue("Deploy Bot");
    await user.selectOptions(within(panel).getByLabelText("Post as"), "Deploy Bot");
    expect(within(panel).queryByLabelText("New app name")).toBeNull();

    // The example has the app's signing secret, dotted out on screen but copied whole.
    const example = within(panel).getByText(/Answers \/deploy for OwnBase/);
    expect(example).not.toHaveTextContent(SECRET);
    await user.click(within(panel).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toContain(`const signingSecret = "${SECRET}";`);
    await user.click(within(panel).getByRole("button", { name: "Reveal secret" }));
    expect(example).toHaveTextContent(SECRET);

    // Missing pieces are asked for by name.
    const createCommand = vi.spyOn(client.api, "createCommand").mockResolvedValue({
      command: {
        id: "SC_1",
        appId: deploy.id,
        command: "deploy",
        url: "https://bot.example.com/deploy",
        description: "",
        usageHint: "",
        createdAt: 0,
      },
    });
    await user.click(within(panel).getByRole("button", { name: "Add command" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent(
      "Give the address your service answers on",
    );
    expect(createCommand).not.toHaveBeenCalled();

    await user.type(within(panel).getByLabelText("Request URL"), "https://bot.example.com/deploy");
    await user.click(within(panel).getByRole("button", { name: "Add command" }));
    expect(createCommand).toHaveBeenCalledWith(deploy.id, {
      command: "deploy",
      url: "https://bot.example.com/deploy",
    });
    expect(client.loadCommands).toHaveBeenCalled();
    expect(listApps).toHaveBeenCalledTimes(2);

    const runCommand = vi
      .spyOn(client.api, "runCommand")
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: "command_failed",
        message: "the app answered 500",
      })
      // An older server says why only in the channel.
      .mockResolvedValueOnce({ ok: false, error: "command_failed" });
    expect(within(panel).getByLabelText("Try it in")).toHaveDisplayValue("#general");
    const send = within(panel).getByRole("button", { name: "Send test command" });
    await user.click(send);
    expect(runCommand).toHaveBeenCalledWith(general.id, { text: "/deploy test" });
    const status = within(panel).getByRole("status");
    expect(status).toHaveTextContent(
      "Your service answered /deploy test. Its reply, if it sent one, is in #general.",
    );
    await user.click(send);
    expect(status).toHaveTextContent("/deploy test failed: the app answered 500.");
    await user.click(send);
    expect(status).toHaveTextContent("/deploy test failed. #general says why.");
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("shows the server's reason when it refuses a command", async () => {
    const deploy = app({ id: "A_DEPLOY", name: "Deploy Bot", botUserId: "U_DEPLOY" });
    const { client, user, dialog } = appsDialog([deploy]);
    await within(dialog).findByText("Deploy Bot", { selector: "span" });
    await user.click(within(dialog).getByRole("tab", { name: "Slash command" }));
    const panel = within(dialog).getByRole("tabpanel", { name: "Slash command" });
    await user.selectOptions(within(panel).getByLabelText("Post as"), "Deploy Bot");
    vi.spyOn(client.api, "createCommand")
      .mockRejectedValueOnce(new ApiError(409, "command_taken", "/deploy is already in use"))
      .mockRejectedValueOnce(new ApiError(400, "invalid_request"));
    await user.type(within(panel).getByLabelText("Request URL"), "https://bot.example.com/deploy");
    await user.click(within(panel).getByRole("button", { name: "Add command" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent("/deploy is already in use");
    await user.click(within(panel).getByRole("button", { name: "Add command" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent(
      "Use letters, digits, - and _ in the command, and an http or https address.",
    );
  });
});
