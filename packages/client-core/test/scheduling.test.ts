import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledMessage, User } from "@ownbase/protocol";
import { ApiError, ScheduledSends, WorkspaceClient } from "../src/index.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const later = Date.UTC(2099, 0, 5, 9);

const queued = (text: string): ScheduledMessage =>
  ({ id: "S1", channelId: "C1", text, sendAt: later, status: "pending" }) as ScheduledMessage;

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

/** A signed-in client that never connects, and a device that keeps what it is given. */
function setup() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({ self: sam, users: { U_SAM: sam } });
  const kept = new Map<string, unknown>();
  const host = {
    storage: {
      get: async <T>(key: string) => (kept.get(key) ?? null) as T | null,
      set: async (key: string, value: unknown) => {
        if (value === null) kept.delete(key);
        else kept.set(key, value);
      },
    },
  };
  return { client, kept, sends: new ScheduledSends(client, host) };
}

describe("scheduling a message", () => {
  it("asks again with the same request when the answer was lost, so it is scheduled once", async () => {
    const { client, kept, sends } = setup();
    const schedule = vi
      .spyOn(client.api, "scheduleMessage")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ scheduled: queued("Ship it") });
    const place = { channelId: "C1" };

    const lost = await sends.schedule(place, { text: " Ship it ", files: [], sendAt: later });
    expect(lost).toMatchObject({ ok: false, saved: { text: "Ship it", sendAt: later } });
    expect(kept.size).toBe(1);
    const saved = await sends.saved(place);
    expect(saved).toEqual({ request: (lost as { saved: unknown }).saved });

    const checked = await sends.check(place, (saved as { request: never }).request);
    expect(checked).toMatchObject({ ok: true, scheduled: { id: "S1" } });
    expect(schedule.mock.calls[1]![1].nonce).toBe(schedule.mock.calls[0]![1].nonce);
    expect(kept.size).toBe(0);
  });

  it("does not upload a file again when scheduling is tried again", async () => {
    const { client, sends } = setup();
    const upload = vi
      .spyOn(client.api, "uploadFile")
      .mockResolvedValue({ file: { id: "F1" } } as never);
    vi.spyOn(client.api, "scheduleMessage")
      .mockRejectedValueOnce(new ApiError(500, "http_error"))
      .mockResolvedValueOnce({ scheduled: queued("") });
    const file = new File(["1,2,3"], "numbers.csv", { type: "text/csv" });
    const draft = { text: "", files: [file], sendAt: later };
    await sends.schedule({ channelId: "C1" }, draft);
    await sends.forget({ channelId: "C1" });
    await sends.schedule({ channelId: "C1" }, draft);
    expect(upload).toHaveBeenCalledOnce();
  });

  it("keeps nothing for a request refused outright, and says why", async () => {
    const { client, kept, sends } = setup();
    vi.spyOn(client.api, "scheduleMessage").mockRejectedValue(
      new ApiError(409, "scheduled_limit", "You already have 200 messages waiting to be sent."),
    );
    const answer = await sends.schedule(
      { channelId: "C1" },
      { text: "x", files: [], sendAt: later },
    );
    expect(answer).toEqual({
      ok: false,
      reason: "You already have 200 messages waiting to be sent. Your draft is still here.",
      saved: null,
    });
    expect(kept.size).toBe(0);
  });

  it("refuses a kept request for another thread than the composer's", async () => {
    const { client, kept, sends } = setup();
    vi.spyOn(client.api, "scheduleMessage").mockRejectedValue(new TypeError("Failed to fetch"));
    await sends.schedule({ channelId: "C1" }, { text: "x", files: [], sendAt: later });
    const [key, request] = [...kept][0]!;
    kept.set(key, { ...(request as object), threadRootId: "R1" });
    expect(await sends.saved({ channelId: "C1" })).toEqual({
      failed:
        "Could not read a message you were scheduling. Your draft is still here. Look in Scheduled before you send it again.",
    });
  });
});
