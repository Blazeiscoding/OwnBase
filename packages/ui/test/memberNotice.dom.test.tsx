import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, MemberNotice, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { MEMBER_NOTICE_SNOOZE_MS } from "../src/components/MemberNotice.js";
import { WorkspaceSettings } from "../src/components/WorkspaceSettings.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * A plan's member notice (P5): past the members the plan includes, the owner
 * and admins are told, under the conversation's header and in Workspace
 * settings, and offered a bigger plan. Nobody else is, and nobody is locked out.
 */
const person = (id: string, role: User["role"] = "member", over: Partial<User> = {}): User => ({
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
  ...over,
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
const TEAM: MemberNotice = {
  members: 3,
  planName: "Team",
  upgradeUrl: "https://example.com/plans?workspace=W_PLAN",
};
const NOW = Date.UTC(2026, 9, 26, 12);

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

/** Saved settings on this device, as the platform keeps them. */
function deviceStorage(saved: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(saved));
  return {
    values,
    storage: {
      get: async <T,>(key: string) => (values.has(key) ? (values.get(key) as T) : null),
      set: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    } satisfies Platform["storage"],
  };
}

function workspaceClient(self: User, others: User[], notice: MemberNotice | null) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self,
    users: Object.fromEntries([self, ...others].map((u) => [u.id, u])),
    workspaceId: "W_PLAN",
    workspaceName: "Rocket Team",
    workspaceSettings: true,
    accessPolicy: "account_required",
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
    memberNotice: notice,
  });
  return client;
}

/** The workspace as `self`, with the others in it and the plan's notice the server sent. */
function workspace(
  self: User,
  others: User[],
  notice: MemberNotice | null = TEAM,
  opts: { saved?: Record<string, unknown>; notifications?: NotificationPermission } = {},
) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("Notification", {
    permission: opts.notifications ?? "granted",
    requestPermission: vi.fn(),
  });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const client = workspaceClient(self, others, notice);
  writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  vi.spyOn(client.api, "channelMembers").mockResolvedValue({ memberIds: [self.id] });
  vi.spyOn(client.api, "listPins").mockResolvedValue({ messages: [], nextCursor: null, total: 0 });
  const device = deviceStorage(opts.saved);
  const platform: Platform = { kind: "web", storage: device.storage, notify: () => {} };
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
  return { client, saved: device.values, user: userEvent.setup() };
}

/** Past the check of saved access, which shows a banner of its own while it waits. */
const opened = () => screen.findByRole("button", { name: /^Members/ }, { timeout: 3_000 });
const notice = () => screen.queryByText(/more than the \d+ .* includes/);

const owner = person("U_OWNER", "owner");
/** Three people the plan counts besides the owner, and three it does not. */
const team = [
  person("U_ADMIN", "admin"),
  person("U_ONE"),
  person("U_TWO"),
  person("U_BOT", "member", { isBot: true }),
  person("U_GUEST", "guest"),
  person("U_GONE", "member", { deactivated: true }),
];

describe("the member notice", () => {
  it("tells the owner past the plan's members, with where to choose a bigger plan", async () => {
    workspace(owner, team);
    const banner = await screen.findByText(/more than the 3 the Team plan includes/);
    expect(banner).toHaveTextContent(
      "This workspace has 4 members, more than the 3 the Team plan includes. Nobody is locked out, and people can keep joining.",
    );
    // Under the header, as a status: nobody has to act on it.
    const header = document.querySelector("header.channel-header")!;
    expect(header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.closest('[role="status"]')).not.toBeNull();
    const link = screen.getByRole("link", { name: "See plans" });
    expect(link).toHaveAttribute("href", TEAM.upgradeUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("tells an admin too, and names no plan and links nowhere when the host gave neither", async () => {
    workspace(person("U_ADMIN", "admin"), [owner, ...team.slice(1)], { members: 3 });
    expect(
      await screen.findByText(/This workspace has 4 members, more than the 3 its plan includes\./),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "See plans" })).toBeNull();
  });

  it("says nothing to members, or at or under the plan's members, until someone joins", async () => {
    workspace(person("U_ONE"), [owner, ...team.filter((u) => u.id !== "U_ONE")]);
    await opened();
    expect(notice()).toBeNull();
    cleanup();

    const { client } = workspace(owner, team.slice(1));
    await opened();
    expect(notice()).toBeNull();
    act(() =>
      client.store.setState((s) => ({
        users: { ...s.users, U_NEW: person("U_NEW") },
      })),
    );
    expect(await screen.findByText(/This workspace has 4 members/)).toBeVisible();
  });

  it("goes for two weeks on this device with Not now, then comes back", async () => {
    const { saved, user } = workspace(owner, team);
    const banner = await screen.findByText(/more than the 3/);
    await user.click(
      within(banner.closest('[role="status"]') as HTMLElement).getByRole("button", {
        name: "Not now",
      }),
    );
    expect(notice()).toBeNull();
    await waitFor(() => expect(saved.get("memberNoticeSnoozedAt:W_PLAN")).toBe(NOW));
    cleanup();

    workspace(owner, team, TEAM, { saved: { "memberNoticeSnoozedAt:W_PLAN": NOW - 1000 } });
    await opened();
    // Storage has answered by now: nothing flashed and nothing is shown.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notice()).toBeNull();
    cleanup();

    workspace(owner, team, TEAM, {
      saved: { "memberNoticeSnoozedAt:W_PLAN": NOW - MEMBER_NOTICE_SNOOZE_MS - 1 },
    });
    expect(await screen.findByText(/more than the 3/)).toBeVisible();
  });

  it("waits behind the ask to turn on notifications", async () => {
    workspace(owner, team, TEAM, { notifications: "default" });
    expect(await screen.findByRole("region", { name: "Notifications" })).toBeVisible();
    // Settled: a notice that came first may still be fading out as the ask takes its place.
    await waitFor(() => expect(notice()).toBeNull());
  });
});

describe("the plan in Workspace settings", () => {
  function settings(self: User, others: User[], notice: MemberNotice | null = TEAM) {
    const client = workspaceClient(self, others, notice);
    vi.spyOn(client.api, "serverInfo").mockResolvedValue({ workspaceCopies: false } as never);
    const platform: Platform = {
      kind: "web",
      storage: deviceStorage().storage,
      notify: () => {},
    };
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ConfirmProvider>
            <WorkspaceSettings onClose={() => {}} />
          </ConfirmProvider>
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return screen.getByRole("dialog", { name: "Workspace settings" });
  }

  it("says how many members the plan includes and how many there are", async () => {
    const dialog = settings(owner, team.slice(1));
    const plan = within(dialog).getByRole("region", { name: "Plan" });
    expect(plan).toHaveTextContent(
      "The Team plan includes 3 members. This workspace has 3. See plans",
    );
    expect(within(plan).getByRole("link", { name: "See plans" })).toHaveAttribute(
      "href",
      TEAM.upgradeUrl,
    );
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("says when there are more, for as long as it is true", () => {
    const dialog = settings(person("U_ADMIN", "admin"), [owner, ...team.slice(1)], {
      members: 3,
    });
    expect(within(dialog).getByRole("region", { name: "Plan" })).toHaveTextContent(
      "This workspace has 4 members, more than the 3 its plan includes. Nobody is locked out, and people can keep joining.",
    );
  });

  it("is not there without a plan", () => {
    const dialog = settings(owner, team, null);
    expect(within(dialog).queryByRole("region", { name: "Plan" })).toBeNull();
  });
});
