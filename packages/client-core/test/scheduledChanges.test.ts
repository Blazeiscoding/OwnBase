import { afterEach, describe, expect, it } from "vitest";
import type { ReadySnapshot, ServerToClient, User } from "@ownbase/protocol";
import { WorkspaceClient } from "../src/index.js";
import { network } from "./network.js";

const net = network({ offline: true });

/**
 * A list of scheduled messages keeps itself current (UX-08): the client counts
 * every change the server reports in this account's queue, and every time it
 * connects, since a change said while it was away was not heard.
 */
const self: User = {
  id: "U1",
  handle: "sam",
  displayName: "Sam",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const ready = (over: Partial<ReadySnapshot> = {}): ReadySnapshot => ({
  type: "ready",
  seq: 0,
  self,
  users: [self],
  channels: [],
  memberships: [],
  channelLastSeq: {},
  presence: {},
  savedMessageIds: [],
  mentionCounts: {},
  threadFollows: [],
  huddles: {},
  huddleRings: [],
  serverTime: 0,
  reminders: [],
  channelRemovals: [],
  reactionsSeenAt: 0,
  unseenReactions: 0,
  pollChoices: {},
  sidebarSections: [],
  notifyDefault: "mentions",
  notifySchedule: null,
  accessPolicy: "account_required",
  iconVersion: null,
  linkPreviews: true,
  customEmoji: [],
  emojiAddingAdminsOnly: false,
  userGroups: [],
  workspaceName: "W",
  workspaceId: "W1",
  friends: [],
  blocked: [],
  replayFrom: null,
  ...over,
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

/** A client whose server is the test. */
function client() {
  const c = new WorkspaceClient("http://127.0.0.1:9", "token");
  clients.push(c);
  c.connect();
  return { client: c, receive: (message: ServerToClient) => net.deliver(message) };
}

describe("changes to the scheduled queue", () => {
  it("are counted as the server reports them", () => {
    const { client: c, receive } = client();
    receive(ready());
    const before = c.state.scheduledChanges;
    receive({ type: "ephemeral", event: { type: "scheduled" } });
    receive({ type: "ephemeral", event: { type: "scheduled" } });
    expect(c.state.scheduledChanges).toBe(before + 2);
  });

  it("are counted on every connection", () => {
    const { client: c, receive } = client();
    expect(c.state.scheduledChanges).toBe(0);
    receive(ready());
    expect(c.state.scheduledChanges).toBe(1);

    receive(ready());
    expect(c.state.scheduledChanges).toBe(2);
  });
});
