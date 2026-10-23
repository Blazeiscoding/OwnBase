import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddleState } from "@slackoss/client-core";
import type { Channel, HuddleRing, Message, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { IncomingCall } from "../src/components/IncomingCall.js";
import { CallNote } from "../src/components/CallNote.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { useRingNotice } from "../src/lib/huddleEnded.js";
import { ringContent } from "../src/lib/notificationPreview.js";
import { accessibilityProblems } from "./accessibility.js";

const joinHuddle = vi.fn(async () => {});
vi.mock("../src/lib/callPreferences.js", async (original) => ({
  ...(await original<typeof import("../src/lib/callPreferences.js")>()),
  // Joining asks for devices and a microphone, which jsdom has neither of.
  useCallPreferences: () => ({ joinHuddle, devices: {} }),
}));
const stopRinging = vi.fn();
const startRingTone = vi.fn(() => stopRinging);
vi.mock("../src/lib/ringTone.js", () => ({ startRingTone: () => startRingTone() }));

/**
 * Ringing for direct calls (E10): the prompt someone rung sees, with its
 * sound and system notification; the note a ring nobody answered leaves; and
 * what the caller reads while it rings and after.
 */
const person = (id: string, displayName: string): User => ({
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
});
const sam = person("U_SAM", "Sam Rivera");
const maya = person("U_MAYA", "Maya Chen");
const lee = person("U_LEE", "Lee Park");
const conversation = (id: string, memberIds: string[]): Channel => ({
  id,
  type: memberIds.length > 2 ? "group_dm" : "dm",
  name: "",
  topic: "",
  description: "",
  creatorId: "U_MAYA",
  archived: false,
  createdAt: 0,
  memberIds,
});
const ring = (over: Partial<HuddleRing> = {}): HuddleRing => ({
  channelId: "C_DM",
  callerId: "U_MAYA",
  startedAt: 1,
  endsAt: 30_001,
  ringing: ["U_SAM"],
  answered: [],
  declined: [],
  ...over,
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  joinHuddle.mockClear();
  startRingTone.mockClear();
  stopRinging.mockClear();
});

function workspace(rings: Record<string, HuddleRing> | null = { C_DM: ring() }) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_MAYA: maya, U_LEE: lee },
    channels: {
      C_DM: conversation("C_DM", ["U_SAM", "U_MAYA"]),
      C_GROUP: conversation("C_GROUP", ["U_SAM", "U_MAYA", "U_LEE"]),
    },
    memberships: { C_DM: 0, C_GROUP: 0 },
    rings,
    status: "online",
    workspaceName: "Rocket Team",
  });
  const notify = vi.fn();
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify,
  };
  const shown = (ui: React.ReactNode) =>
    render(
      <ToastProvider>
        <ConfirmProvider>
          <PlatformContext.Provider value={platform}>
            <ClientContext.Provider value={client}>{ui}</ClientContext.Provider>
          </PlatformContext.Provider>
        </ConfirmProvider>
      </ToastProvider>,
    );
  return { client, notify, shown, user: userEvent.setup() };
}

describe("a ring someone gets", () => {
  it("says who is calling, rings, and goes when the ring stops", async () => {
    const { client, shown } = workspace();
    const onOpen = vi.fn();
    const { container } = shown(<IncomingCall onOpen={onOpen} preview="full" tag="sam" />);
    const prompt = screen.getByRole("region", { name: "Maya Chen is calling" });
    expect(prompt).toHaveTextContent("Huddle with you");
    expect(screen.getByRole("alert")).toHaveTextContent("Maya Chen is calling");
    expect(startRingTone).toHaveBeenCalledTimes(1);
    expect(await accessibilityProblems(container)).toEqual([]);

    act(() => client.store.setState({ rings: {} }));
    expect(screen.queryByRole("region", { name: /is calling/ })).toBeNull();
    expect(stopRinging).toHaveBeenCalledTimes(1);
  });

  it("joins from Join, opening the conversation, and says no from Decline", async () => {
    const { client, shown, user } = workspace();
    const declineRing = vi.spyOn(client, "declineRing");
    const onOpen = vi.fn();
    shown(<IncomingCall onOpen={onOpen} preview="full" tag="sam" />);
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(onOpen).toHaveBeenCalledWith("C_DM");
    expect(joinHuddle).toHaveBeenCalledWith(client, "C_DM", expect.any(Function));

    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(declineRing).toHaveBeenCalledWith("C_DM");
  });

  // The group by the name the sidebar gives it.
  it("names the group a group ring is in", () => {
    const { shown } = workspace({ C_GROUP: ring({ channelId: "C_GROUP" }) });
    shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(screen.getByRole("region", { name: "Maya Chen is calling" })).toHaveTextContent(
      "Huddle with Maya Chen, Lee Park",
    );
  });

  it("shows nothing for a ring someone else is answering, or one this account makes", () => {
    const { shown } = workspace({
      C_DM: ring({ ringing: [], answered: ["U_SAM"] }),
      C_GROUP: ring({ channelId: "C_GROUP", callerId: "U_SAM", ringing: ["U_MAYA", "U_LEE"] }),
    });
    const { container } = shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(container).toBeEmptyDOMElement();
    expect(startRingTone).not.toHaveBeenCalled();
  });

  it("tells the system once while the window is behind, as much as the device allows", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { client, notify, shown } = workspace();
    const onOpen = vi.fn();
    shown(<IncomingCall onOpen={onOpen} preview="full" tag="sam" />);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Maya Chen is calling",
      "Huddle with you",
      expect.any(Function),
      {
        tag: "sam ring C_DM",
      },
    );
    // Clicking it opens the conversation.
    notify.mock.calls[0]![2]();
    expect(onOpen).toHaveBeenCalledWith("C_DM");
    // The same ring changing does not tell it again.
    act(() => client.store.setState({ rings: { C_DM: ring({ declined: ["U_LEE"] }) } }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ringContent("none", { from: "Maya Chen" })).toEqual({
      title: "Incoming huddle",
      body: "Open Tandem to answer it.",
    });
  });

  it("tells the system nothing while the window is in front", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { notify, shown } = workspace();
    shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(notify).not.toHaveBeenCalled();
  });

  it("rings silently during Do Not Disturb, and in a muted conversation", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { client, notify, shown } = workspace();
    act(() => client.store.setState({ self: { ...sam, dndUntil: Date.now() + 60_000 } }));
    shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(screen.getByRole("region", { name: "Maya Chen is calling" })).toBeInTheDocument();
    expect(startRingTone).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    cleanup();

    const muted = workspace();
    act(() =>
      muted.client.store.setState({ prefs: { C_DM: { notifyLevel: "all", muted: true } } }),
    );
    muted.shown(<IncomingCall onOpen={vi.fn()} preview="full" tag="sam" />);
    expect(screen.getByRole("region", { name: "Maya Chen is calling" })).toBeInTheDocument();
    expect(startRingTone).not.toHaveBeenCalled();
    expect(muted.notify).not.toHaveBeenCalled();
  });
});

describe("a missed huddle's note", () => {
  const note = (userId: string): Message => ({
    id: "M_NOTE",
    channelId: "C_DM",
    userId,
    text: "Missed huddle",
    threadRootId: null,
    broadcast: false,
    seq: 3,
    createdAt: 0,
    editedAt: null,
    nonce: null,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
    call: { kind: "missed" },
  });

  it("offers the one who missed it a call back, or the huddle still going", async () => {
    const { client, shown, user } = workspace(null);
    const { container } = shown(<CallNote message={note("U_MAYA")} />);
    expect(container).toHaveTextContent("Missed huddle");
    await user.click(screen.getByRole("button", { name: "Call back" }));
    expect(joinHuddle).toHaveBeenCalledWith(client, "C_DM", expect.any(Function));
    act(() => client.store.setState({ huddles: { C_DM: ["U_MAYA"] } }));
    expect(screen.getByRole("button", { name: "Join huddle" })).toBeInTheDocument();
    // Already in it here: nothing to press.
    act(() => client.store.setState({ huddle: { channelId: "C_DM" } as HuddleState }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(await accessibilityProblems(container)).toEqual([]);
  });

  it("tells the caller nobody answered, with nothing to press and no way to edit it", () => {
    const { shown } = workspace(null);
    shown(<MessageItem message={note("U_SAM")} compact={false} onOpenThread={vi.fn()} />);
    expect(screen.getByRole("article")).toHaveTextContent("No answer");
    expect(screen.queryByRole("button", { name: "Call back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });
});

describe("the caller", () => {
  const inCall = (client: WorkspaceClient, peers: HuddleState["peers"] = []) =>
    client.store.setState({
      huddle: {
        channelId: "C_GROUP",
        micMuted: false,
        cameraOn: false,
        sharingScreen: false,
        localCameraStream: null,
        localScreenStream: null,
        speaking: false,
        micLost: false,
        peers,
      },
    });

  it("reads who it is ringing while alone, and beside who is there", () => {
    const { client, shown } = workspace({
      C_GROUP: ring({ channelId: "C_GROUP", callerId: "U_SAM", ringing: ["U_MAYA", "U_LEE"] }),
    });
    inCall(client);
    shown(<HuddleBar />);
    expect(screen.getByRole("status")).toHaveTextContent("Ringing Maya Chen and Lee Park…");
    act(() => {
      inCall(client, [
        {
          userId: "U_MAYA",
          audioStream: null,
          cameraStream: null,
          screenStream: null,
          connected: true,
          micMuted: false,
          speaking: false,
        },
      ]);
      client.store.setState({
        rings: {
          C_GROUP: ring({
            channelId: "C_GROUP",
            callerId: "U_SAM",
            ringing: ["U_LEE"],
            answered: ["U_MAYA"],
          }),
        },
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("With Maya Chen · Ringing Lee Park…");
    act(() => client.store.setState({ rings: {} }));
    expect(screen.getByRole("status")).toHaveTextContent(/^With Maya Chen$/);
  });

  it("hears once who declined, or that nobody answered", async () => {
    const { client, shown } = workspace(null);
    function Notices() {
      useRingNotice();
      return null;
    }
    shown(<Notices />);
    act(() =>
      client.store.setState({
        ringNotice: { channelId: "C_DM", message: "Maya Chen declined", at: 1 },
      }),
    );
    await waitFor(() => expect(screen.getByText("Maya Chen declined")).toBeInTheDocument());
    act(() =>
      client.store.setState({ ringNotice: { channelId: "C_DM", message: "No answer", at: 2 } }),
    );
    await waitFor(() => expect(screen.getByText("No answer")).toBeInTheDocument());
  });
});
