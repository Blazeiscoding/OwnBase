import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import type { User } from "@ownbase/protocol";
import { Api, ApiError, WorkspaceClient, type WorkspaceState } from "../src/index.js";

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

describe("the / hint list", () => {
  let server: WorkspaceServer;
  let dataDir: string;
  let base: string;
  let token: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-client-commands-"));
    server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
    base = `http://127.0.0.1:${server.port}`;
    token = (
      await new Api(base).register({ handle: "ada", displayName: "Ada", password: "password123" })
    ).token;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const until = (client: WorkspaceClient, predicate: (s: WorkspaceState) => boolean) =>
    vi.waitFor(() => expect(predicate(client.state)).toBe(true), { timeout: 5000 });
  const names = (client: WorkspaceClient) => client.state.commands.map((c) => c.command);

  it("loads once connected, and again when a command comes or goes", async () => {
    const client = new WorkspaceClient(base, token);
    clients.push(client);
    client.connect();
    await until(client, (s) => s.status === "online" && s.commands.length > 0);
    expect(names(client)).toEqual(expect.arrayContaining(["shrug", "away", "poll"]));

    const app = await client.apps.create({ name: "Deployer", scopes: ["chat:write"] });
    if (app instanceof ApiError) throw app;
    const command = await client.apps.createCommand(app.app.id, {
      command: "deploy",
      url: "https://bot.example.com/deploy",
    });
    if (command instanceof ApiError) throw command;
    await until(client, () => names(client).includes("deploy"));

    expect(await client.apps.removeCommand(command.id)).toBeNull();
    await until(client, () => !names(client).includes("deploy"));
  });
});
