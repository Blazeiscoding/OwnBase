import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type AppDetail } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { AppsDialog } from "../src/components/AppsDialog.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { accessibilityProblems } from "./accessibility.js";

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

const deployApp: AppDetail = {
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
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function appsDialog() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: owner, users: { [owner.id]: owner }, status: "online" });
  const user = userEvent.setup();
  function renderDialog() {
    render(
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <AppsDialog onClose={() => {}} />
        </ClientContext.Provider>
      </ConfirmProvider>,
    );
    return screen.getByRole("dialog", { name: "Apps and integrations" });
  }
  return { client, user, renderDialog };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Apps list status", () => {
  it("reports a failed first load without claiming there are no apps, then retries to an empty list", async () => {
    const { client, user, renderDialog } = appsDialog();
    const retryLoad = deferred<{ apps: AppDetail[] }>();
    const listApps = vi
      .spyOn(client.api, "listApps")
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => retryLoad.promise);
    const dialog = renderDialog();
    const status = within(dialog).getByRole("status");

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not load apps. Check your connection and try again.",
    );
    expect(within(dialog).queryByText(/No apps yet/)).not.toBeInTheDocument();
    expect(listApps).toHaveBeenCalledTimes(1);

    const retry = within(dialog).getByRole("button", { name: "Retry" });
    retry.focus();
    await user.keyboard("{Enter}");
    expect(listApps).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Loading apps…");
    expect(within(dialog).queryByText(/No apps yet/)).not.toBeInTheDocument();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");

    await act(async () => retryLoad.resolve({ apps: [] }));
    expect(within(dialog).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(
      "No apps yet. Create one above to connect it to this workspace.",
    );
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(status.parentElement).toHaveFocus();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("keeps a newer app list when an overlapping initial load answers last", async () => {
    const { client, user, renderDialog } = appsDialog();
    const firstLoad = deferred<{ apps: AppDetail[] }>();
    const listedApp: AppDetail = { ...deployApp, id: "A_LISTED", name: "Listed Bot" };
    const listApps = vi
      .spyOn(client.api, "listApps")
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce({ apps: [deployApp, listedApp] });
    vi.spyOn(client.api, "createApp").mockResolvedValue({
      app: deployApp,
      botUser: owner,
      token: "test-bot-token-not-a-credential",
      signingSecret: deployApp.signingSecret,
    });
    const dialog = renderDialog();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading apps…");

    await user.type(within(dialog).getByRole("textbox", { name: "App name" }), "Deploy Bot");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Deploy Bot", { selector: "span" })).toBeVisible();
    expect(await within(dialog).findByText("Listed Bot", { selector: "span" })).toBeVisible();
    expect(listApps).toHaveBeenCalledTimes(2);

    await act(async () => firstLoad.resolve({ apps: [] }));
    expect(within(dialog).getByText("Deploy Bot", { selector: "span" })).toBeVisible();
    expect(within(dialog).getByText("Listed Bot", { selector: "span" })).toBeVisible();
    expect(within(dialog).queryByText(/No apps yet/)).not.toBeInTheDocument();
  });

  it("keeps a newly created app and its one-time token visible when refresh fails", async () => {
    const { client, user, renderDialog } = appsDialog();
    vi.spyOn(client.api, "listApps")
      .mockResolvedValueOnce({ apps: [] })
      .mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(client.api, "createApp").mockResolvedValue({
      app: deployApp,
      botUser: owner,
      token: "test-bot-token-not-a-credential",
      signingSecret: deployApp.signingSecret,
    });
    const dialog = renderDialog();
    expect(await within(dialog).findByText(/No apps yet/)).toBeVisible();

    await user.type(within(dialog).getByRole("textbox", { name: "App name" }), "Deploy Bot");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not load apps");
    expect(within(dialog).getByText("Deploy Bot", { selector: "span" })).toBeVisible();
    expect(within(dialog).getByText("test-bot-token-not-a-credential")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeVisible();
    expect(within(dialog).queryByText(/No apps yet/)).not.toBeInTheDocument();
  });

  it("shows a retryable error if a quiet delivery-status poll fails", async () => {
    vi.useFakeTimers();
    const { client, renderDialog } = appsDialog();
    const pendingApp: AppDetail = {
      ...deployApp,
      subscriptions: [
        {
          id: "S_PENDING",
          appId: deployApp.id,
          url: "https://bot.example.com/events",
          eventTypes: [],
          createdAt: 0,
          delivery: { pending: 1, failed: 0, dropped: 0, lastError: null, lastFailedAt: null },
        },
      ],
    };
    const listApps = vi
      .spyOn(client.api, "listApps")
      .mockResolvedValueOnce({ apps: [pendingApp] })
      .mockRejectedValueOnce(new Error("offline"));
    const dialog = renderDialog();
    await act(async () => {});
    expect(within(dialog).getByText("Deploy Bot", { selector: "span" })).toBeVisible();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(listApps).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Could not load apps");
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeVisible();
    expect(within(dialog).getByText("Deploy Bot", { selector: "span" })).toBeVisible();
  });
});
