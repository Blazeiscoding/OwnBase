import { afterEach, describe, expect, it } from "vitest";
import type { ServerToClient } from "@ownbase/protocol";
import { WorkspaceClient } from "../src/index.js";
import {
  EPHEMERAL_CUT_NOTE,
  EPHEMERAL_LIMITS,
  keepEphemeral,
  type EphemeralMessage,
} from "../src/workspace.js";

/**
 * Private command answers are kept within limits (REV-04). The deep review
 * fed 1,000 unique and five repeated answers through the socket and found
 * 1,005 kept and the repeated id shown six times.
 */
const { perConversation, total, totalChars, answerChars } = EPHEMERAL_LIMITS;
let clock = 1_000;
const answer = (channelId: string, id: string, text = `answer ${id}`): EphemeralMessage => ({
  id,
  channelId,
  userId: "B1",
  text,
  createdAt: ++clock,
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

/** A client that is never connected, fed frames as its socket would be. */
function client(): { client: WorkspaceClient; receive: (message: EphemeralMessage) => void } {
  const c = new WorkspaceClient("http://127.0.0.1:9", "token");
  clients.push(c);
  const connection = c as unknown as { handleServerMessage(message: ServerToClient): void };
  return {
    client: c,
    receive: (message) =>
      connection.handleServerMessage({
        type: "ephemeral",
        event: { type: "ephemeral.message", ...message },
      }),
  };
}

const kept = (c: WorkspaceClient) => Object.values(c.state.ephemerals).flat();
const keptChars = (c: WorkspaceClient) => kept(c).reduce((sum, e) => sum + e.text.length, 0);

describe("private answers in one conversation", () => {
  it("keeps the newest, in order, and counts what it let go", () => {
    const { client: c, receive } = client();
    for (let i = 1; i <= perConversation + 5; i++) receive(answer("C1", `E${i}`));
    const shown = c.state.ephemerals.C1!.map((e) => e.id);
    expect(shown).toHaveLength(perConversation);
    expect(shown[0]).toBe("E6");
    expect(shown.at(-1)).toBe(`E${perConversation + 5}`);
    expect(c.state.ephemeralsDropped).toEqual({ C1: 5 });
    // What was let go is counted, never kept.
    expect(JSON.stringify(c.state)).not.toContain('answer E5"');
  });

  it("shows an answer repeated by id once, as it last arrived", () => {
    const { client: c, receive } = client();
    receive(answer("C1", "E1"));
    receive(answer("C1", "E2"));
    for (let i = 0; i < 5; i++) receive(answer("C1", "E1", `edited ${i}`));
    expect(c.state.ephemerals.C1!.map((e) => [e.id, e.text])).toEqual([
      ["E1", "edited 4"],
      ["E2", "answer E2"],
    ]);
    expect(c.state.ephemeralsDropped).toEqual({});
  });

  it("moves an answer whose id arrives again in another conversation", () => {
    const { client: c, receive } = client();
    receive(answer("C1", "E1"));
    receive(answer("C2", "E1", "moved"));
    expect(c.state.ephemerals).toEqual({
      C2: [expect.objectContaining({ id: "E1", text: "moved" })],
    });
    expect(c.state.ephemeralsDropped).toEqual({});
  });

  it("cuts an answer too long to keep, and says so", () => {
    const { client: c, receive } = client();
    receive(answer("C1", "E1", "x".repeat(answerChars * 3)));
    const text = c.state.ephemerals.C1![0]!.text;
    expect(text).toHaveLength(answerChars + EPHEMERAL_CUT_NOTE.length);
    expect(text.endsWith(EPHEMERAL_CUT_NOTE)).toBe(true);
  });
});

describe("private answers across the workspace", () => {
  it("stays within its limits after a thousand answers and repeats", () => {
    const { client: c, receive } = client();
    for (let i = 0; i < 1_000; i++)
      receive(answer(`C${i % 10}`, `E${i}`, `answer ${i} `.repeat(50)));
    for (let i = 0; i < 5; i++) receive(answer("C9", "E999", "the last one again"));
    expect(kept(c).length).toBeLessThanOrEqual(total);
    expect(keptChars(c)).toBeLessThanOrEqual(totalChars);
    for (const list of Object.values(c.state.ephemerals))
      expect(list.length).toBeLessThanOrEqual(perConversation);
    // The repeated id is one row, the newest answer.
    expect(
      kept(c)
        .filter((e) => e.id === "E999")
        .map((e) => e.text),
    ).toEqual(["the last one again"]);
    // Everything let go is accounted for, conversation by conversation.
    const dropped = Object.values(c.state.ephemeralsDropped).reduce((a, b) => a + b, 0);
    expect(dropped + kept(c).length).toBe(1_000);
    expect(JSON.stringify(c.state.ephemerals).length).toBeLessThan(totalChars * 1.2);
  });

  it("lets the oldest go first when text, not count, is the limit", () => {
    const { client: c, receive } = client();
    const long = Math.floor(answerChars * 0.9);
    const n = Math.ceil(totalChars / long) + 3;
    for (let i = 0; i < n; i++) receive(answer(`C${i % 3}`, `E${i}`, "y".repeat(long)));
    expect(keptChars(c)).toBeLessThanOrEqual(totalChars);
    const ids = kept(c).map((e) => Number(e.id.slice(1)));
    expect(Math.max(...ids)).toBe(n - 1);
    // A contiguous run of the newest: none older than one kept is gone.
    expect(Math.min(...ids)).toBe(n - ids.length);
  });

  it("never lets go of the answer that just arrived", () => {
    const state = keepEphemeral({}, {}, answer("C1", "only", "z".repeat(answerChars)));
    expect(state.ephemerals.C1).toHaveLength(1);
  });
});

describe("clearing private answers", () => {
  it("dismisses one answer, then the notice of those let go", () => {
    const { client: c, receive } = client();
    for (let i = 1; i <= perConversation + 1; i++) receive(answer("C1", `E${i}`));
    c.dismissEphemeral("C1", "E2");
    expect(c.state.ephemerals.C1!.map((e) => e.id)).not.toContain("E2");
    expect(c.state.ephemeralsDropped).toEqual({ C1: 1 });
    c.dismissDroppedEphemerals("C1");
    expect(c.state.ephemeralsDropped).toEqual({});
    expect(c.state.ephemerals.C1).toHaveLength(perConversation - 1);
  });

  it("forgets both when this person loses the conversation", () => {
    const { client: c, receive } = client();
    for (let i = 1; i <= perConversation + 2; i++) receive(answer("C1", `E${i}`));
    receive(answer("C2", "other"));
    // What a channel.access event without a channel does, once the client is synced.
    (c as unknown as { removeChannel(channelId: string): void }).removeChannel("C1");
    expect(c.state.ephemerals).toEqual({ C2: [expect.objectContaining({ id: "other" })] });
    expect(c.state.ephemeralsDropped).toEqual({});
  });
});
