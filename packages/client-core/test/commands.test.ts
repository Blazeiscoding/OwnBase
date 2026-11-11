import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@ownbase/protocol";
import { WorkspaceClient } from "../src/index.js";

const sam = { id: "U_SAM", displayName: "Sam Rivera", role: "member" } as User;

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

function signedIn() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({ self: sam, users: { U_SAM: sam } });
  const run = vi.spyOn(client.api, "runCommand").mockResolvedValue({ ok: true });
  return { client, run };
}

describe("a slash command typed as a message", () => {
  it("is handed back when the app runs it, and never sent", () => {
    const { client, run } = signedIn();
    expect(client.send("C1", "/away")).toEqual({ kind: "in_app", name: "away", args: "" });
    expect(client.send("C1", "  /STATUS 🌴 On holiday ")).toEqual({
      kind: "in_app",
      name: "status",
      args: "🌴 On holiday",
    });
    expect(client.send("C1", "/poll Lunch?")).toEqual({
      kind: "in_app",
      name: "poll",
      args: "Lunch?",
    });
    expect(run).not.toHaveBeenCalled();
    expect(client.state.pending).toEqual([]);
  });

  it("goes to the server when the server or an app runs it", () => {
    const { client, run } = signedIn();
    expect(client.send("C1", "/shrug hm", { threadRootId: "M1" })).toEqual({ kind: "command" });
    expect(run).toHaveBeenCalledWith("C1", { text: "/shrug hm", threadRootId: "M1" });
    expect(client.state.pending).toEqual([]);
  });

  it("is an ordinary message when it carries files, or is a path", () => {
    const { client, run } = signedIn();
    expect(client.send("C1", "/Users/me/notes.txt").kind).toBe("queued");
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    expect(client.send("C1", "/away", { files: [file] }).kind).toBe("queued");
    expect(run).not.toHaveBeenCalled();
  });
});
