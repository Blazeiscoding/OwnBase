import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, MemberNotice, ServerNotice, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { SERVER_NOTICE_SNOOZE_MS } from "../src/components/ServerNotice.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/**
 * What the server's extensions tell the owner and admins (P6), under the
 * conversation's header: an alert until the app opens again, news for two
 * weeks once put away, and never to anyone else.
 */
const person = (id: string, role: User["role"]): User => ({
  id,
  handle: id.toLowerCase(),
  displayName: id,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U_OWNER",
  archived: false,
  createdAt: 0,
};
const NOW = Date.UTC(2026, 9, 27, 12);
const ended: ServerNotice = {
  id: "license:lic-acme:grace",
  tone: "alert",
  text: "The Enterprise license for Acme Ltd ended on 25 October 2026. Its features stop on 8 November 2026; chat keeps working.",
};
const ending: ServerNotice = {
  id: "license:lic-acme:ending",
  tone: "status",
  text: "The Enterprise license for Acme Ltd ends on 6 November 2026. Renew it to keep its features.",
  link: { label: "Renew", url: "https://example.com/renew?license=lic-acme" },
};

const clients: WorkspaceClient[] = [];
// jsdom lays nothing out, so it has nothing to scroll into view.
Element.prototype.scrollIntoView ??= () => {};
afterEach(() => {
  // Unmount before the globals go: vitest runs these hooks in reverse.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function workspace(
  role: User["role"],
  notices: ServerNotice[],
  opts: {
    saved?: Record<string, unknown>;
    memberNotice?: MemberNotice;
    /** Held until it settles: what storage says about server notices. */
    noticesRead?: Promise<void>;
  } = {},
) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const self = person("U_SELF", role);
  const others = [person("U_A", "member"), person("U_B", "member"), person("U_C", "member")];
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self,
    users: Object.fromEntries([self, ...others].map((u) => [u.id, u])),
    workspaceId: "W_EE",
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
    serverNotices: notices,
    memberNotice: opts.memberNotice ?? null,
  });
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  vi.spyOn(client.api, "channelMembers").mockResolvedValue({ memberIds: [self.id] });
  vi.spyOn(client.api, "listPins").mockResolvedValue({ messages: [], nextCursor: null, total: 0 });
  const saved = new Map(Object.entries(opts.saved ?? {}));
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => {
        if (key.startsWith("serverNoticeSnoozedAt:")) await opts.noticesRead;
        return saved.has(key) ? (saved.get(key) as T) : null;
      },
      set: async (key: string, value: unknown) => {
        saved.set(key, value);
      },
    },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { client, saved, user: userEvent.setup() };
}

/** Past the check of saved access, which shows a banner of its own while it waits. */
const opened = () => screen.findByRole("button", { name: /^Members/ }, { timeout: 3_000 });

describe("a server notice", () => {
  it("shows an alert to the owner, as an alert, until dismissed for this visit", async () => {
    const { saved, user } = workspace("owner", [ended, ending]);
    const alert = await screen.findByText(ended.text);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    // The next one takes its place; dismissing an alert is not remembered.
    expect(await screen.findByText(ending.text)).toBeVisible();
    expect(screen.queryByText(ended.text)).toBeNull();
    expect([...saved.keys()].filter((key) => key.startsWith("serverNotice"))).toEqual([]);
    cleanup();

    workspace("owner", [ended, ending]);
    expect(await screen.findByText(ended.text)).toBeVisible();
  });

  it("puts news away for two weeks with Not now, and links where the extension says", async () => {
    const { saved, user } = workspace("admin", [ending]);
    const news = await screen.findByText(ending.text);
    expect(news.closest('[role="status"]')).not.toBeNull();
    const link = screen.getByRole("link", { name: "Renew" });
    expect(link).toHaveAttribute("href", ending.link!.url);
    expect(link).toHaveAttribute("target", "_blank");
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(ending.text)).toBeNull();
    await waitFor(() =>
      expect(saved.get("serverNoticeSnoozedAt:W_EE:license:lic-acme:ending")).toBe(NOW),
    );
    cleanup();

    workspace("admin", [ending], {
      saved: { "serverNoticeSnoozedAt:W_EE:license:lic-acme:ending": NOW - 1000 },
    });
    await opened();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(ending.text)).toBeNull();
    cleanup();

    workspace("admin", [ending], {
      saved: {
        "serverNoticeSnoozedAt:W_EE:license:lic-acme:ending": NOW - SERVER_NOTICE_SNOOZE_MS - 1,
      },
    });
    expect(await screen.findByText(ending.text)).toBeVisible();
  });

  it("is never shown to a member", async () => {
    workspace("member", [ended, ending]);
    await opened();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(ended.text)).toBeNull();
    expect(screen.queryByText(ending.text)).toBeNull();
  });

  it("comes before the plan's member notice, which waits for it", async () => {
    const { user } = workspace("owner", [ended], { memberNotice: { members: 2 } });
    expect(await screen.findByText(ended.text)).toBeVisible();
    expect(screen.queryByText(/more than the 2 its plan includes/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText(/more than the 2 its plan includes/)).toBeVisible();
  });

  it("keeps the member notice back while finding out whether its own was put away", async () => {
    let answer!: () => void;
    const noticesRead = new Promise<void>((resolve) => (answer = resolve));
    workspace("owner", [ending], {
      memberNotice: { members: 2 },
      saved: { [`serverNoticeSnoozedAt:W_EE:${ending.id}`]: NOW - 1000 },
      noticesRead,
    });
    await screen.findByRole("button", { name: /^Members/ });
    // Storage has not answered: the member notice is not shown, then taken back.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/more than the 2 its plan includes/)).toBeNull();
    answer();
    // It was put away, so the member notice has the place.
    expect(await screen.findByText(/more than the 2 its plan includes/)).toBeVisible();
    expect(screen.queryByText(ending.text)).toBeNull();
  });
});
