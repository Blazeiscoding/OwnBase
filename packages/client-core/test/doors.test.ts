import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Message, Reminder, User } from "@ownbase/protocol";
import { ApiError, WorkspaceClient } from "../src/index.js";

/**
 * What the UI asks of the client: news it listens for, and changes whose
 * answer the store keeps, so no screen has to write the store itself (U6).
 */
const user = (id: string, extra: Partial<User> = {}) =>
  ({ id, handle: id.toLowerCase(), displayName: id, role: "member", ...extra }) as User;

function signedIn() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const sam = user("U_SAM", { role: "owner" });
  const kai = user("U_KAI");
  client.store.setState({ self: sam, users: { [sam.id]: sam, [kai.id]: kai } });
  return { client, sam, kai };
}

afterEach(() => vi.restoreAllMocks());

describe("listening to a client", () => {
  const emit = (client: WorkspaceClient, id: string) =>
    (
      client as unknown as { events: { emit: (event: "messageDeleted", id: string) => void } }
    ).events.emit("messageDeleted", id);

  it("tells every listener, and stops telling only the one that left", () => {
    const { client } = signedIn();
    const heard: string[] = [];
    const stopFirst = client.on("messageDeleted", (id) => heard.push(`first ${id}`));
    client.on("messageDeleted", (id) => heard.push(`second ${id}`));
    emit(client, "M1");
    stopFirst();
    emit(client, "M2");
    expect(heard).toEqual(["first M1", "second M1", "second M2"]);
  });

  it("keeps telling the others when one listener throws", () => {
    const { client } = signedIn();
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    const heard: string[] = [];
    client.on("messageDeleted", () => {
      throw new TypeError("Illegal constructor");
    });
    client.on("messageDeleted", (id) => heard.push(id));
    emit(client, "M1");
    expect(heard).toEqual(["M1"]);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("takes the same function twice as two listeners", () => {
    const { client } = signedIn();
    const due = vi.fn();
    const stop = client.on("reminderDue", due);
    client.on("reminderDue", due);
    (
      client as unknown as {
        events: { emit: (e: "reminderDue", r: Reminder, m: Message) => void };
      }
    ).events.emit("reminderDue", {} as Reminder, {} as Message);
    stop();
    expect(due).toHaveBeenCalledTimes(2);
  });
});

describe("changes whose answer the client keeps", () => {
  it("shows a friendship as the server answered it", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "updateFriend").mockResolvedValue({
      friends: [{ userId: "U_KAI", status: "outgoing" }],
    } as never);
    expect(await client.setFriendship("U_KAI", "request")).toBeNull();
    expect(client.state.friends).toEqual([{ userId: "U_KAI", status: "outgoing" }]);
  });

  it("says why a friendship did not change, and leaves the list as it was", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "updateFriend").mockRejectedValue(new ApiError(400, "invalid_friend"));
    expect(await client.setFriendship("U_KAI", "request")).toMatchObject({ code: "invalid_friend" });
    expect(client.state.friends).toEqual([]);
  });

  it("shows someone's new role before the socket's copy of it", async () => {
    const { client, kai } = signedIn();
    vi.spyOn(client.api, "updateUserAdmin").mockResolvedValue({
      user: { ...kai, role: "admin" },
    } as never);
    await client.admin.changePerson(kai.id, { role: "admin" });
    expect(client.state.users[kai.id]!.role).toBe("admin");
  });

  it("shows a handed-over workspace with this account no longer its owner", async () => {
    const { client, sam, kai } = signedIn();
    vi.spyOn(client.api, "transferOwnership").mockResolvedValue({
      owner: { ...kai, role: "owner" },
      previousOwner: { ...sam, role: "admin" },
    } as never);
    await client.admin.transferOwnership(kai.id);
    expect(client.state.users[kai.id]!.role).toBe("owner");
    expect(client.state.self!.role).toBe("admin");
  });

  it("shows this account's new status before the socket's copy of it", async () => {
    const { client, sam } = signedIn();
    vi.spyOn(client.api, "updateMe").mockImplementation(
      async (body) => ({ user: { ...sam, ...body } }) as never,
    );
    expect(await client.updateProfile({ statusText: "On holiday" })).toBeNull();
    expect(client.state.self!.statusText).toBe("On holiday");
  });

  it("shows a conversation it made before the socket's copy of it", async () => {
    const { client } = signedIn();
    client.store.setState({ lastSeq: 7 });
    const design = { id: "C_DESIGN", type: "public", name: "design" } as Channel;
    vi.spyOn(client.api, "createChannel").mockResolvedValue({ channel: design } as never);
    expect(await client.createChannel({ type: "public", name: "design" })).toBe(design);
    expect(client.state.channels[design.id]).toBe(design);
    expect(design.id in client.state.memberships).toBe(true);
  });
});

describe("the largest file a workspace takes", () => {
  it("is asked once, and asked again after the server could not say", async () => {
    const { client } = signedIn();
    const usage = vi
      .spyOn(client.api, "storageUsage")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ maxFileBytes: 1_000 } as never);
    expect(await client.maxFileBytes()).toBeNull();
    expect(await client.maxFileBytes()).toBe(1_000);
    expect(await client.maxFileBytes()).toBe(1_000);
    expect(usage).toHaveBeenCalledTimes(2);
  });
});

describe("signing out", () => {
  it("is on purpose once asked for, and not after it failed", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "logout").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.signOut()).rejects.toThrow("Failed to fetch");
    expect(client.signedOutOnPurpose).toBe(false);
    vi.spyOn(client.api, "logout").mockResolvedValue({ ok: true });
    await client.signOut();
    expect(client.signedOutOnPurpose).toBe(true);
  });
});
