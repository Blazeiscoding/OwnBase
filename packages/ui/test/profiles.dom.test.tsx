import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import { currentZoneName, type Channel, type User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { Avatar } from "../src/components/Avatar.js";
import { ProfileDialog, ProfileForm } from "../src/components/ProfileDialog.js";
import { PartnerTime } from "../src/components/PartnerTime.js";
import { AccountMenu } from "../src/components/Sidebar.js";
import { MembersPanel } from "../src/components/MembersPanel.js";
import { useIdleReport } from "../src/lib/idle.js";
import { accessibilityProblems } from "./accessibility.js";

vi.mock("../src/lib/iconImage.js", async (original) => ({
  ...(await original<typeof import("../src/lib/iconImage.js")>()),
  // jsdom draws no pictures: the prepared one stands in.
  prepareIcon: vi.fn(async () => new Blob(["webp"], { type: "image/webp" })),
}));

/**
 * Profiles (E9): a picture in place of initials, the local time on a profile
 * and beside a direct message, away by hand and in words, the picture and
 * time zone chosen in settings, and a device saying it is idle.
 */
const person = (id: string, displayName: string, over: Partial<User> = {}): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  ...over,
});
const sam = person("U_SAM", "Sam Rivera", { timeZone: "Europe/London" });
const maya = person("U_MAYA", "Maya Chen", {
  timeZone: "Asia/Tokyo",
  avatarVersion: "a1b2c3d4e5f6a7b8",
});
const dm: Channel = {
  id: "C_DM",
  type: "dm",
  name: "",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
  memberIds: ["U_SAM", "U_MAYA"],
};
const at = (zone: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(
    Date.now(),
  );

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function workspace(
  over: { self?: User; users?: User[]; presence?: Record<string, "online" | "away"> } = {},
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  const self = over.self ?? sam;
  const users = Object.fromEntries([self, ...(over.users ?? [maya])].map((u) => [u.id, u]));
  client.store.setState({
    self,
    users,
    channels: { C_DM: dm },
    memberships: { C_DM: 0 },
    presence: over.presence ?? {},
    profiles: true,
    status: "online",
    workspaceName: "Rocket Team",
  });
  vi.spyOn(client.avatars, "load").mockResolvedValue("blob:maya");
  return { client, user: userEvent.setup() };
}
const shown = (client: WorkspaceClient, ui: React.ReactNode) =>
  render(<ClientContext.Provider value={client}>{ui}</ClientContext.Provider>);

describe("a profile picture", () => {
  it("shows in place of the initials once fetched, and the initials for someone with none", async () => {
    const { client } = workspace();
    const { container } = shown(
      client,
      <>
        <Avatar user={maya} />
        <Avatar user={sam} />
      </>,
    );
    await waitFor(() => expect(container.querySelector("img")).toHaveAttribute("src", "blob:maya"));
    expect(client.avatars.load).toHaveBeenCalledWith("U_MAYA", "a1b2c3d4e5f6a7b8");
    expect(container).toHaveTextContent("SR");
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});

describe("someone's profile", () => {
  it("says they are away, and their local time and zone where it differs", async () => {
    const { client } = workspace({ presence: { U_MAYA: "away" } });
    shown(client, <ProfileDialog userId="U_MAYA" onClose={vi.fn()} onOpenDm={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Profile" });
    expect(within(dialog).getByRole("img", { name: "Away" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Away");
    expect(dialog).toHaveTextContent(`${at("Asia/Tokyo")} local time· Asia/Tokyo`);
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("gives their local time but not their zone when their clock reads as yours", () => {
    const { client } = workspace({ users: [{ ...maya, timeZone: "Europe/London" }] });
    shown(client, <ProfileDialog userId="U_MAYA" onClose={vi.fn()} onOpenDm={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Profile" });
    expect(dialog).toHaveTextContent(`${at("Europe/London")} local time`);
    expect(dialog).not.toHaveTextContent("Europe/London");
  });

  it("writes a zone as people do, with spaces", () => {
    const { client } = workspace({ users: [{ ...maya, timeZone: "America/New_York" }] });
    shown(client, <ProfileDialog userId="U_MAYA" onClose={vi.fn()} onOpenDm={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Profile" })).toHaveTextContent(
      `${at("America/New_York")} local time· America/New York`,
    );
  });

  it("gives no local time for someone whose zone is not known", () => {
    const { client } = workspace({ users: [person("U_NEW", "New Person")] });
    shown(client, <ProfileDialog userId="U_NEW" onClose={vi.fn()} onOpenDm={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Profile" })).not.toHaveTextContent("local time");
  });
});

describe("a direct message's header", () => {
  it("gives the other person's time when their clock reads otherwise", () => {
    const { client } = workspace();
    shown(client, <PartnerTime channelId="C_DM" />);
    expect(screen.getByText(`${at("Asia/Tokyo")} for Maya Chen`)).toBeInTheDocument();
  });

  it("says nothing when it reads the same", () => {
    const { client } = workspace({
      users: [{ ...maya, timeZone: "Europe/London" }],
    });
    const { container } = shown(client, <PartnerTime channelId="C_DM" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing with more than one other person, whose clocks may each read otherwise", () => {
    const lee = person("U_LEE", "Lee Park", { timeZone: "Asia/Tokyo" });
    const { client } = workspace({ users: [maya, lee] });
    client.store.setState((s) => ({
      channels: {
        ...s.channels,
        C_GROUP: {
          ...dm,
          id: "C_GROUP",
          type: "group_dm",
          memberIds: ["U_SAM", "U_MAYA", "U_LEE"],
        },
      },
    }));
    const { container } = shown(client, <PartnerTime channelId="C_GROUP" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("away by hand", () => {
  const menu = (client: WorkspaceClient) =>
    shown(
      client,
      <AccountMenu
        guest={false}
        snoozed={false}
        onEditProfile={vi.fn()}
        onAccountSettings={vi.fn()}
      />,
    );

  it("is set from the account menu, and set back from it", async () => {
    const { client, user } = workspace();
    const updateMe = vi.spyOn(client.api, "updateMe").mockImplementation(async (body) => ({
      user: { ...sam, ...(body.away ? { away: true as const } : {}) },
    }));
    menu(client);
    await user.click(screen.getByRole("button", { name: /your account$/ }));
    await user.click(screen.getByRole("menuitem", { name: "Set yourself away" }));
    expect(updateMe).toHaveBeenCalledWith({ away: true });
    await waitFor(() => expect(client.state.self?.away).toBe(true));
    await user.click(screen.getByRole("button", { name: /your account$/ }));
    await user.click(screen.getByRole("menuitem", { name: "Set yourself active" }));
    expect(updateMe).toHaveBeenLastCalledWith({ away: false });
  });

  it("is not offered by a server that keeps no profiles", async () => {
    const { client, user } = workspace();
    client.store.setState({ profiles: false });
    menu(client);
    await user.click(screen.getByRole("button", { name: /your account$/ }));
    expect(screen.queryByRole("menuitem", { name: /Set yourself/ })).toBeNull();
  });
});

describe("the members list", () => {
  it("keeps someone away among those here, saying so", async () => {
    const { client } = workspace({ presence: { U_SAM: "online", U_MAYA: "away" } });
    vi.spyOn(client.api, "channelMembers").mockResolvedValue({
      memberIds: ["U_SAM", "U_MAYA"],
    } as never);
    shown(client, <MembersPanel channelId="C_DM" onClose={vi.fn()} onOpenProfile={vi.fn()} />);
    const panel = await screen.findByRole("complementary", { name: "Members" });
    await waitFor(() => expect(panel).toHaveTextContent("Online — 2"));
    expect(within(panel).getByRole("button", { name: /Maya Chen/ })).toHaveTextContent("Away");
  });
});

describe("your profile in settings", () => {
  // Fifteen seconds: axe reads every one of the four hundred zones in the list,
  // which under a full parallel run came past the five-second default.
  it("takes a picture, removes it, and a time zone", { timeout: 15_000 }, async () => {
    const { client, user } = workspace({ self: { ...sam, timeZone: "Asia/Kolkata" } });
    const now = () => client.state.self!;
    const setAvatar = vi
      .spyOn(client.api, "setAvatar")
      .mockImplementation(async () => ({ user: { ...now(), avatarVersion: "0011223344556677" } }));
    const removeAvatar = vi.spyOn(client.api, "removeAvatar").mockImplementation(async () => {
      const { avatarVersion: _gone, ...user } = now();
      return { user };
    });
    const updateMe = vi.spyOn(client.api, "updateMe").mockImplementation(async (body) => ({
      user: { ...now(), timeZone: body.timeZone ?? undefined },
    }));
    const { container } = shown(client, <ProfileForm />);

    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(picker, new File(["png"], "me.png", { type: "image/png" }));
    await waitFor(() => expect(setAvatar).toHaveBeenCalled());
    expect((setAvatar.mock.calls[0]![0] as Blob).type).toBe("image/webp");
    expect(await screen.findByRole("button", { name: "Change picture" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeAvatar).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Upload a picture" })).toBeInTheDocument();

    const zone = screen.getByRole("combobox", { name: "Time zone" });
    expect(zone).toHaveValue("Asia/Kolkata");
    await user.selectOptions(zone, "Asia/Tokyo");
    expect(updateMe).toHaveBeenLastCalledWith({ timeZone: "Asia/Tokyo" });
    expect(await screen.findByText("Time zone saved.")).toBeInTheDocument();
    // This device's own zone, a press away.
    await user.click(screen.getByRole("button", { name: "Use it" }));
    expect(updateMe).toHaveBeenLastCalledWith({
      timeZone: currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone),
    });
    expect(await accessibilityProblems(container)).toEqual([]);
  });

  it("takes a device that says Asia/Calcutta, as Chromium does, to be in Asia/Kolkata", async () => {
    const original = process.env.TZ;
    const before = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "Asia/Calcutta";
    try {
      const { client, user } = workspace({ self: { ...sam, timeZone: "Europe/London" } });
      const updateMe = vi.spyOn(client.api, "updateMe").mockImplementation(async (body) => ({
        user: { ...client.state.self!, timeZone: body.timeZone ?? undefined },
      }));
      shown(client, <ProfileForm />);
      expect(screen.getByText(/This device is in Asia\/Kolkata\./)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Use it" }));
      expect(updateMe).toHaveBeenLastCalledWith({ timeZone: "Asia/Kolkata" });
      // Its zone now, by either name: nothing more to offer.
      await waitFor(() => expect(screen.queryByRole("button", { name: "Use it" })).toBeNull());
      const zone = screen.getByRole("combobox", { name: "Time zone" });
      expect(zone).toHaveValue("Asia/Kolkata");
      const offered = within(zone)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value"));
      expect(offered.filter((name) => name === "Asia/Kolkata")).toHaveLength(1);
      expect(offered).not.toContain("Asia/Calcutta");
      expect(within(zone).getByRole("option", { name: "America/New York" })).toBeInTheDocument();
    } finally {
      process.env.TZ = original ?? before;
    }
  });
});

describe("this device going idle", () => {
  function Reporter({ client }: { client: WorkspaceClient }) {
    useIdleReport(client, 60_000);
    return null;
  }

  it("is said after its quiet time, and back as soon as it is used", async () => {
    vi.useFakeTimers();
    const { client } = workspace();
    const setIdle = vi.spyOn(client, "setIdle");
    render(<Reporter client={client} />);
    act(() => void vi.advanceTimersByTime(59_000));
    expect(setIdle).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1_500));
    expect(setIdle).toHaveBeenLastCalledWith(true);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })));
    expect(setIdle).toHaveBeenLastCalledWith(false);
    // Use keeps putting it off.
    act(() => void vi.advanceTimersByTime(40_000));
    act(() => void window.dispatchEvent(new PointerEvent("pointerdown")));
    act(() => void vi.advanceTimersByTime(40_000));
    expect(setIdle).toHaveBeenCalledTimes(2);
  });
});
