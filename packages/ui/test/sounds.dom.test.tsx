import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { Navigation } from "../src/lib/navigation.js";
import { startNotifications } from "../src/lib/notifications.js";
import { forgetAudio } from "../src/lib/sounds.js";
import type { Platform } from "../src/platform.js";
import { render } from "./render.js";
import { accessibilityProblems } from "./accessibility.js";

/** The app's own notification sounds (K10). */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const sam = person("U_SAM", "Sam");
const maya = person("U_MAYA", "Maya");
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
};
const dm: Channel = { ...general, id: "C_DM", name: "", type: "dm", memberIds: [sam.id, maya.id] };

/** Web Audio stood in for: the pitches of each tone played, one list per tone. */
let played: number[][];
beforeEach(() => {
  played = [];
  forgetAudio();
  const level = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createGain() {
      // A tone starts with its output, the one gain joined to the speakers.
      return {
        gain: level(),
        connect: (to: unknown) => void (to === this.destination && played.push([])),
      };
    }
    createOscillator() {
      const frequency = level();
      return {
        type: "",
        frequency,
        connect() {},
        start: () => played.at(-1)!.push(frequency.value),
        stop() {},
      };
    }
    async resume() {}
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function device(saved: unknown) {
  const set = vi.fn(async () => {});
  const notify = vi.fn();
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => (key === "sounds" ? saved : null) as T | null,
      set,
    },
    notify,
  };
  return { platform, set, notify };
}

function workspace(platform: Platform) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [maya.id]: maya },
    channels: { [general.id]: general, [dm.id]: dm },
    memberships: { [general.id]: 0, [dm.id]: 0 },
    status: "online",
  });
  const navigation = new Navigation(client, client.baseUrl, { channelId: null });
  const stop = startNotifications({
    client,
    navigation,
    platform,
    preview: () => "full",
    account: () => "sam@test",
    hear: () => {},
  });
  let seq = 0;
  const arrive = (channelId: string, text: string) => {
    seq++;
    const message = {
      id: `M${seq}`,
      channelId,
      userId: maya.id,
      text,
      seq,
      threadRootId: null,
      createdAt: 0,
      editedAt: null,
      reactions: [],
    } as unknown as Message;
    (client as unknown as { events: { emit: (...args: unknown[]) => void } }).events.emit(
      "message",
      message,
      { live: true },
    );
  };
  return { client, arrive, stop };
}

const CHIME = [880, 1175];
const KNOCK = [196, 196];
const BELL = [1046, 2093];

describe("notification sounds", () => {
  it("sound the chosen tone once, a direct message's apart, and send the system's notification silent", async () => {
    const { platform, notify } = device({ messages: "bell", directMessages: "knock" });
    const { arrive, stop } = workspace(platform);
    // Before the sounds have arrived, the system's own sound is the one there is.
    arrive(dm.id, "first");
    expect(notify).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Function),
      {
        tag: "sam@test M1",
        silent: false,
      },
    );
    expect(played).toEqual([]);
    await waitFor(() => {
      arrive(dm.id, "again");
      expect(notify.mock.lastCall![3]).toMatchObject({ silent: true });
    });
    expect(played.at(-1)).toEqual(KNOCK);
    const count = played.length;
    arrive(general.id, `<@${sam.id}> look`);
    expect(notify.mock.lastCall![3]).toMatchObject({ silent: true });
    expect(played.length).toBe(count + 1);
    expect(played.at(-1)).toEqual(BELL);
    stop();
  });

  it("make no sound, and keep the system quiet, for None", async () => {
    const { platform, notify } = device({ messages: "none", directMessages: "none" });
    const { arrive, stop } = workspace(platform);
    arrive(dm.id, "first");
    await waitFor(() => {
      arrive(dm.id, "again");
      expect(notify.mock.lastCall![3]).toMatchObject({ silent: true });
    });
    expect(played).toEqual([]);
    stop();
  });

  it("sound in one window of the account: another that holds the sound stays quiet", async () => {
    const { platform, notify } = device({ messages: "bell", directMessages: "chime" });
    // Another window of this account takes each sound, until it stops.
    const elsewhere = { holds: true };
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async (_name: string, _options: unknown, run: (lock: object | null) => unknown) =>
          run(elsewhere.holds ? null : {}),
      },
    });
    const { arrive, stop } = workspace(platform);
    arrive(dm.id, "first");
    await waitFor(() => {
      arrive(dm.id, "taken elsewhere");
      expect(notify.mock.lastCall![3]).toMatchObject({ silent: true });
    });
    await Promise.resolve();
    expect(played).toEqual([]);
    elsewhere.holds = false;
    arrive(dm.id, "this one is ours");
    await waitFor(() => expect(played).toEqual([CHIME]));
    stop();
  });

  it("sound someone coming into and leaving the call", async () => {
    const { platform } = device(null);
    const { client, stop } = workspace(platform);
    const call = (userIds: string[]) =>
      client.store.setState({
        huddle: {
          channelId: general.id,
          peers: userIds.map((userId) => ({ userId })),
        } as never,
      });
    call([]);
    // The sounds and this device's choices arrive as the workspace opens.
    await new Promise((resolve) => setTimeout(resolve, 50));
    call([maya.id]);
    await waitFor(() => expect(played).toEqual([[523, 784]]));
    call([]);
    await waitFor(() =>
      expect(played).toEqual([
        [523, 784],
        [784, 523],
      ]),
    );
    stop();
  });

  it("are chosen in Notifications, played as they are picked, and kept", async () => {
    const { platform, set } = device(null);
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    clients.push(client);
    client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
    vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <AccountDialog onClose={() => {}} section="notifications" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const user = userEvent.setup();
    const sounds = await screen.findByRole("group", { name: "Sounds" });
    const direct = within(sounds).getByRole("combobox", { name: "Direct messages" });
    await waitFor(() => expect(direct).toBeEnabled());
    expect(direct).toHaveValue("chime");
    await user.selectOptions(direct, "Bell");
    expect(played).toEqual([BELL]);
    expect(set).toHaveBeenLastCalledWith("sounds", {
      messages: "pop",
      directMessages: "bell",
      calls: true,
    });
    await user.click(
      within(sounds).getByRole("button", { name: "Play the sound for direct messages" }),
    );
    expect(played).toEqual([BELL, BELL]);
    await user.selectOptions(direct, "None");
    expect(within(sounds).queryByRole("button", { name: /direct messages/ })).toBeNull();
    await user.click(within(sounds).getByRole("checkbox", { name: /joins or leaves your call/ }));
    expect(set).toHaveBeenLastCalledWith("sounds", {
      messages: "pop",
      directMessages: "none",
      calls: false,
    });
    expect(await accessibilityProblems(sounds)).toEqual([]);
  });
});
