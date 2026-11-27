import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddleState } from "@ownbase/client-core";
import type { Channel, HuddleRing, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { IncomingCall } from "../src/components/IncomingCall.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { RING_NOTICE_MS } from "../src/lib/huddleView.js";
import { accessibilityProblems } from "./accessibility.js";
import { render } from "./render.js";

/**
 * Asking someone into a channel's call (K18): the picker in the call's menu,
 * the card the person asked sees, the line whoever asked reads when they
 * cannot join, and the link to the call.
 */
const person = (id: string, displayName: string, over: Partial<User> = {}): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  ...over,
});
const maya = person("U_MAYA", "Maya Chen");
const sam = person("U_SAM", "Sam Ortiz");
const priya = person("U_PRIYA", "Priya Shah");
const alex = person("U_ALEX", "Alex Kim");
const bot = person("U_BOT", "Deploy Bot", { isBot: true });
const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: "U_MAYA",
  archived: false,
  createdAt: 0,
};
const asked = (over: Partial<HuddleRing> = {}): HuddleRing => ({
  channelId: "C_DESIGN",
  callerId: "U_MAYA",
  startedAt: 1,
  endsAt: 30_001,
  ringing: ["U_SAM"],
  answered: [],
  declined: [],
  askedBy: { U_SAM: "U_MAYA" },
  ...over,
});
const peer = (userId: string): HuddleState["peers"][number] => ({
  userId,
  audioStream: null,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
});
const huddle = (peers: HuddleState["peers"]): HuddleState => ({
  channelId: "C_DESIGN",
  micMuted: false,
  cameraOn: false,
  sharingScreen: false,
  localCameraStream: null,
  localScreenStream: null,
  speaking: false,
  micLost: false,
  peers,
});

beforeEach(() => {
  // The ring tone's Web Audio, which jsdom lacks.
  class Silent {
    currentTime = 0;
    destination = {};
    createGain = () => ({
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    });
    createOscillator = () => ({
      frequency: { setValueAtTime() {} },
      connect() {},
      start() {},
      stop() {},
    });
    resume = async () => {};
    close = async () => {};
  }
  vi.stubGlobal("AudioContext", Silent);
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function workspace(self: User) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self,
    users: { U_MAYA: maya, U_SAM: sam, U_PRIYA: priya, U_ALEX: alex, U_BOT: bot },
    channels: { C_DESIGN: design },
    memberships: { C_DESIGN: 0 },
    status: "online",
  });
  const notify = vi.fn();
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify,
  };
  const shown = (ui: React.ReactNode) =>
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>{ui}</ClientContext.Provider>
      </PlatformContext.Provider>,
    );
  return { client, notify, shown };
}

describe("the card someone asked into a call sees", () => {
  it("names who asked and the channel, and declines from Decline", async () => {
    const { client, shown } = workspace(sam);
    client.store.setState({ rings: { C_DESIGN: asked() } });
    const declineRing = vi.spyOn(client, "declineRing").mockImplementation(() => {});
    shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    const card = screen.getByRole("region", {
      name: "Maya Chen is asking you to join the call in #design",
    });
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(await accessibilityProblems(card.parentElement!)).toEqual([]);
    await userEvent.setup().click(within(card).getByRole("button", { name: "Decline" }));
    expect(declineRing).toHaveBeenCalledWith("C_DESIGN");
  });

  it("names whoever asked this account, when someone else asked first", () => {
    const { client, shown } = workspace(sam);
    client.store.setState({
      rings: {
        C_DESIGN: asked({
          callerId: "U_PRIYA",
          ringing: ["U_ALEX", "U_SAM"],
          askedBy: { U_ALEX: "U_PRIYA", U_SAM: "U_MAYA" },
        }),
      },
    });
    shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(
      screen.getByRole("region", { name: "Maya Chen is asking you to join the call in #design" }),
    ).toBeInTheDocument();
  });

  it("shows nothing when this account blocked whoever asked", () => {
    const { client, shown } = workspace(sam);
    client.store.setState({ rings: { C_DESIGN: asked() }, blocked: ["U_MAYA"] });
    const { container } = shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("tells the system in the same words while the window is behind", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { client, notify, shown } = workspace(sam);
    client.store.setState({ rings: { C_DESIGN: asked() } });
    shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(notify).toHaveBeenCalledWith(
      "Maya Chen is asking you to join the call in #design",
      "Open OwnBase to join or decline.",
      expect.any(Function),
      { tag: "sam ring C_DESIGN" },
    );
  });

  it("stays silent outside the hours the account allows notifications", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { client, notify, shown } = workspace(sam);
    // A minute each day, two hours from now.
    const later = new Date(Date.now() + 2 * 3_600_000);
    const at = (minute: number) =>
      `${String(later.getHours()).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const hours = { from: at(0), to: at(1) };
    client.store.setState({
      rings: { C_DESIGN: asked() },
      notifySchedule: { kind: "custom", days: Array.from({ length: 7 }, () => hours) },
    });
    shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(screen.getByRole("region", { name: /is asking you to join/ })).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("asking from the call", () => {
  function inDesignCall() {
    const ctx = workspace(maya);
    ctx.client.store.setState({
      huddle: huddle([peer("U_PRIYA")]),
      huddles: { C_DESIGN: ["U_MAYA", "U_PRIYA"] },
    });
    vi.spyOn(ctx.client, "channelMembers").mockResolvedValue([
      "U_MAYA",
      "U_SAM",
      "U_PRIYA",
      "U_ALEX",
      "U_BOT",
    ]);
    const ring = vi.spyOn(ctx.client, "ringIntoCall").mockImplementation((userId) =>
      ctx.client.store.setState((s) => ({
        rings: {
          C_DESIGN: asked({
            ringing: [...(s.rings.C_DESIGN?.ringing ?? []), userId],
            askedBy: { ...s.rings.C_DESIGN?.askedBy, [userId]: "U_MAYA" },
          }),
        },
      })),
    );
    ctx.shown(<HuddleBar onOpenSettings={() => {}} />);
    return { ...ctx, ring };
  }

  it("offers members of the channel not in the call, and rings each one chosen", async () => {
    const { ring } = inDesignCall();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More call options" }));
    await user.click(screen.getByRole("menuitem", { name: "Ask someone to join" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask someone to join" });
    const field = await within(dialog).findByLabelText("Find someone in #design");
    expect(field).toHaveFocus();
    // Not Maya herself, nor Priya, already in the call, nor an app.
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.getAttribute("aria-label")),
    ).toEqual(["Alex Kim @alex", "Sam Ortiz @sam"]);
    await user.type(field, "sam");
    await user.keyboard("{Enter}");
    expect(ring).toHaveBeenCalledWith("U_SAM");
    const list = within(dialog).getByRole("list", { name: "Asked" });
    expect(within(list).getByRole("listitem")).toHaveTextContent("Sam OrtizRinging…");
    // Being rung, Sam is not offered again.
    await user.clear(field);
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.getAttribute("aria-label")),
    ).toEqual(["Alex Kim @alex"]);
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("offers no one to ask in a direct call, which rang everyone already", async () => {
    const { client } = inDesignCall();
    act(() =>
      client.store.setState({
        channels: {
          C_DESIGN: { ...design, type: "dm", name: "", memberIds: ["U_MAYA", "U_PRIYA"] },
        },
      }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "More call options" }));
    expect(screen.queryByRole("menuitem", { name: "Ask someone to join" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Copy link to call" })).toBeInTheDocument();
  });

  it("copies a link that opens the conversation and offers its call", async () => {
    const { client } = inDesignCall();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More call options" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy link to call" }));
    expect(await navigator.clipboard.readText()).toBe(`${client.baseUrl}/#/c/C_DESIGN/call`);
  });

  it("says in the bar for a few seconds that someone asked can't join", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client } = inDesignCall();
    const status = within(screen.getByRole("region", { name: "Active huddle" })).getByRole(
      "status",
    );
    act(() =>
      client.store.setState({
        ringNotice: { channelId: "C_DESIGN", message: "Sam Ortiz can't join now", at: Date.now() },
      }),
    );
    expect(status).toHaveTextContent("With Priya Shah · Sam Ortiz can't join now");
    act(() => {
      vi.advanceTimersByTime(RING_NOTICE_MS);
    });
    expect(status).toHaveTextContent(/^With Priya Shah$/);
  });
});
