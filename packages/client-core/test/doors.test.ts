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
    expect(await client.setFriendship("U_KAI", "request")).toMatchObject({
      code: "invalid_friend",
    });
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

describe("account and admin changes that are refused", () => {
  it("answers with the server's refusal rather than throwing it", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "changePassword").mockRejectedValue(
      new ApiError(403, "invalid_credentials"),
    );
    expect(await client.account.changePassword("old", "new-password")).toMatchObject({
      status: 403,
      code: "invalid_credentials",
    });
  });

  it("answers an unreachable workspace as a network error", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "listReports").mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await client.admin.reports()).toMatchObject({ code: "network_error" });
  });

  it("leaves someone as they were when changing them is refused", async () => {
    const { client, kai } = signedIn();
    vi.spyOn(client.api, "updateUserAdmin").mockRejectedValue(
      new ApiError(403, "admins_are_equals"),
    );
    expect(await client.admin.changePerson(kai.id, { role: "admin" })).toMatchObject({
      code: "admins_are_equals",
    });
    expect(client.state.users[kai.id]!.role).toBe("member");
  });

  it("refuses a sign-in link that leaves the workspace's server", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "connectSignIn").mockResolvedValue({
      url: "https://elsewhere.example/steal",
    } as never);
    const method = { id: "oidc", name: "Okta", connect: "/api/ee/sso/connect" } as never;
    expect(await client.account.linkSignInUrl(method)).toMatchObject({
      code: "invalid_response",
    });
  });

  it("gives what was asked for once the server answers", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "resetPassword").mockResolvedValue({ temporaryPassword: "temp-horse" });
    expect(await client.admin.resetPassword("U_KAI")).toBe("temp-horse");
    vi.spyOn(client.api, "revokeOtherSessions").mockResolvedValue({ revoked: 2 });
    expect(await client.account.signOutOtherDevices()).toBeNull();
  });
});

describe("app changes", () => {
  it("answers with the server's refusal, or a network error, rather than throwing", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "createCommand").mockRejectedValue(
      new ApiError(409, "command_taken", "/deploy is already in use"),
    );
    expect(
      await client.apps.createCommand("A_DEPLOY", { command: "deploy", url: "https://x.test" }),
    ).toMatchObject({ status: 409, code: "command_taken", message: "/deploy is already in use" });
    vi.spyOn(client.api, "deleteApp").mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await client.apps.remove("A_DEPLOY")).toMatchObject({ code: "network_error" });
  });

  it("gives what was asked for, or null for a change with nothing to give", async () => {
    const { client } = signedIn();
    vi.spyOn(client.api, "listApps").mockResolvedValue({ apps: [] });
    expect(await client.apps.list()).toEqual([]);
    vi.spyOn(client.api, "replaceAppToken").mockResolvedValue({ token: "xoxb-not-a-credential" });
    expect(await client.apps.replaceToken("A_DEPLOY")).toBe("xoxb-not-a-credential");
    vi.spyOn(client.api, "deleteWebhook").mockResolvedValue({ ok: true } as never);
    expect(await client.apps.removeWebhook("W_1")).toBeNull();
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
    expect(await client.signOut()).toMatchObject({ code: "network_error" });
    expect(client.signedOutOnPurpose).toBe(false);
    vi.spyOn(client.api, "logout").mockResolvedValue({ ok: true });
    expect(await client.signOut()).toBeNull();
    expect(client.signedOutOnPurpose).toBe(true);
  });
});
