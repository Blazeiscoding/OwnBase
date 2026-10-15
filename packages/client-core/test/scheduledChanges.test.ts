import { afterEach, describe, expect, it } from "vitest";
import type { ReadySnapshot, ServerToClient, User } from "@slackoss/protocol";
import { WorkspaceClient } from "../src/index.js";

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
  huddles: {},
  workspaceName: "W",
  ...over,
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

/** A client that is never connected, fed frames as its socket would be. */
function client() {
  const c = new WorkspaceClient("http://127.0.0.1:9", "token");
  clients.push(c);
  const connection = c as unknown as { handleServerMessage(message: ServerToClient): void };
  return {
    client: c,
    receive: (message: ServerToClient) => connection.handleServerMessage(message),
  };
}

describe("changes to the scheduled queue", () => {
  it("are counted as the server reports them", () => {
    const { client: c, receive } = client();
    receive(ready({ scheduledEvents: true }));
    const before = c.state.scheduledChanges;
    receive({ type: "ephemeral", event: { type: "scheduled" } });
    receive({ type: "ephemeral", event: { type: "scheduled" } });
    expect(c.state.scheduledChanges).toBe(before + 2);
  });

  it("are counted on every connection, which also says whether the server reports them", () => {
    const { client: c, receive } = client();
    expect(c.state.scheduledChanges).toBe(0);
    receive(ready({ scheduledEvents: true }));
    expect(c.state.scheduledEvents).toBe(true);
    expect(c.state.scheduledChanges).toBe(1);

    // An older server says nothing, so a list has to ask it now and then.
    receive(ready());
    expect(c.state.scheduledEvents).toBe(false);
    expect(c.state.scheduledChanges).toBe(2);
  });
});
