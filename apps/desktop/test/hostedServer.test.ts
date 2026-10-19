import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, deflateSync } from "node:zlib";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { holdWorkspace } from "@slackoss/server/ownership";
import { startHostedServer, type HostedServerHost } from "../src/main/hostedServer.js";
import { readWorkspaceIcon, readWorkspaceIconVersion } from "../src/main/registry.js";

let root: string;
let dataDir: string;
let created: WorkspaceServer[];
let host: HostedServerHost;

/** A real one-colour PNG, made here so no test holds an image's bytes. */
function png(size = 4): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x60)]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.ok,
    () => false,
  );

/** Makes the workspace's database refuse to save who may join, as a failing disk would. */
function refusePolicyWrites(on: boolean) {
  const db = new DatabaseSync(join(dataDir, "workspace.db"));
  try {
    db.exec(
      on
        ? `CREATE TRIGGER refuse_policy BEFORE INSERT ON meta WHEN NEW.key = 'access_policy'
           BEGIN SELECT RAISE(ABORT, 'policy refused'); END`
        : "DROP TRIGGER refuse_policy",
    );
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tandem-hosted-server-"));
  dataDir = join(root, "workspace");
  created = [];
  host = {
    // The real server, kept off the network: no announcement, this computer only.
    createServer: async (options) => {
      const server = await createWorkspaceServer({ ...options, mdns: false, host: "127.0.0.1" });
      created.push(server);
      return server;
    },
    webDistPath: join(root, "no-web"),
    savedRelay: async () => null,
    relayServers: new Set(),
    publicAddressConfigured: () => false,
  };
  // A workspace that has run before, so starting it writes nothing of its own.
  await (await startHostedServer({ dataDir, port: 0, workspaceName: "Rocket Team" }, host)).stop();
  created = [];
});

afterEach(async () => {
  await Promise.all(created.map((server) => server.stop().catch(() => {})));
  rmSync(root, { recursive: true, force: true });
});

describe("starting a hosted workspace's server", () => {
  it("hands over a running server, and lets go of it when it is stopped", async () => {
    const hosted = await startHostedServer({ dataDir, port: 0 }, host);

    expect(await answers(hosted.port)).toBe(true);
    expect(hosted.workspaceName!()).toBe("Rocket Team");
    expect(hosted.inviteOnly!()).toBe(false);
    expect([...host.relayServers]).toEqual(created);

    await hosted.stop();
    expect(host.relayServers.size).toBe(0);
    expect(await answers(hosted.port)).toBe(false);
  });

  it("closes joining before handing over when a public address is set", async () => {
    host.publicAddressConfigured = () => true;
    const hosted = await startHostedServer({ dataDir, port: 0 }, host);
    expect(hosted.inviteOnly!()).toBe(true);
    await hosted.stop();
  });

  it("keeps who may join and the name an admin chose, start after start, and says when they change", async () => {
    const hosted = await startHostedServer({ dataDir, port: 0 }, host);
    const base = `http://127.0.0.1:${hosted.port}`;
    const send = (method: string, path: string, body: unknown, token?: string) =>
      fetch(base + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const { token, user } = (await (
      await send("POST", "/api/auth/register", {
        handle: "owner",
        displayName: "Owner",
        password: "password123",
      })
    ).json()) as { token: string; user: { id: string } };
    const heard: unknown[] = [];
    hosted.onWorkspaceChange!((change) => heard.push(change));

    expect(
      (await send("PUT", "/api/admin/workspace/name", { name: "Blue Team" }, token)).status,
    ).toBe(200);
    expect(
      (
        await send(
          "PUT",
          "/api/admin/workspace/access-policy",
          { accessPolicy: "guest_allowed" },
          token,
        )
      ).status,
    ).toBe(200);
    expect(heard).toEqual([
      { workspaceName: "Blue Team", by: user.id },
      { accessPolicy: "guest_allowed", by: user.id },
    ]);
    expect(hosted.workspaceName!()).toBe("Blue Team");
    expect(hosted.accessPolicy!()).toBe("guest_allowed");
    await hosted.stop();

    // Nothing the app keeps is handed back to the next start, and a name
    // given to it, as for a new workspace, does not replace the one it has.
    const again = await startHostedServer({ dataDir, port: 0, workspaceName: "Rocket Team" }, host);
    expect(again.workspaceName!()).toBe("Blue Team");
    expect(again.accessPolicy!()).toBe("guest_allowed");
    await again.stop();
  });

  it("shows the icon an admin sets, and leaves it to be read from the folder once stopped", async () => {
    const hosted = await startHostedServer({ dataDir, port: 0 }, host);
    const base = `http://127.0.0.1:${hosted.port}`;
    const { token, user } = (await (
      await fetch(base + "/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
      })
    ).json()) as { token: string; user: { id: string } };
    const heard: unknown[] = [];
    hosted.onWorkspaceChange!((change) => heard.push(change));
    const bytes = png(6);
    const response = await fetch(base + "/api/admin/workspace/icon", {
      method: "PUT",
      headers: { "content-type": "image/png", authorization: `Bearer ${token}` },
      body: bytes,
    });
    const { iconVersion } = (await response.json()) as { iconVersion: string };
    expect(heard).toEqual([{ iconVersion, by: user.id }]);
    expect(hosted.workspaceIcon!()).toMatchObject({ type: "image/png", version: iconVersion });
    // Read from the folder while the server holds it too: reading changes nothing.
    expect(readWorkspaceIconVersion(dataDir)).toBe(iconVersion);
    await hosted.stop();

    expect(readWorkspaceIconVersion(dataDir)).toBe(iconVersion);
    expect(readWorkspaceIcon(dataDir)).toEqual({
      version: iconVersion,
      url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    });
    expect(readWorkspaceIcon(join(root, "nothing-here"))).toBeNull();
    expect(readWorkspaceIconVersion(join(root, "nothing-here"))).toBeNull();
  });

  it("stops the server it made when joining cannot be closed, and gives the folder back (Q12)", async () => {
    host.publicAddressConfigured = () => true;
    refusePolicyWrites(true);

    await expect(startHostedServer({ dataDir, port: 0 }, host)).rejects.toThrow(/policy refused/);

    // It was listening by then. Nothing is left answering, tracked or holding the folder.
    expect(created).toHaveLength(1);
    expect(await answers(created[0]!.port)).toBe(false);
    expect(host.relayServers.size).toBe(0);
    holdWorkspace(dataDir, "a test").release();

    // And the same workspace starts once its database takes the write.
    refusePolicyWrites(false);
    const hosted = await startHostedServer({ dataDir, port: 0 }, host);
    expect(hosted.inviteOnly!()).toBe(true);
    expect(await answers(hosted.port)).toBe(true);
    await hosted.stop();
  });

  it("says so when the server it made could not be stopped either", async () => {
    const refused = new Error("policy refused");
    const stuck = new Error("drain failed");
    const server = {
      port: 1,
      setInviteOnly: () => {
        throw refused;
      },
      stop: vi.fn(async () => {
        throw stuck;
      }),
    } as unknown as WorkspaceServer;
    host.createServer = async () => server;
    host.publicAddressConfigured = () => true;

    const failure = await startHostedServer({ dataDir, port: 0 }, host).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([refused, stuck]);
    expect((failure as Error).message).toMatch(/could not be stopped/);
    expect(server.stop).toHaveBeenCalledOnce();
    expect(host.relayServers.size).toBe(0);
  });

  it("keeps a restored copy being looked inside to this computer, unannounced and untracked", async () => {
    const asked: Parameters<HostedServerHost["createServer"]>[0][] = [];
    const real = host.createServer;
    host.createServer = (options) => {
      asked.push(options);
      return real(options);
    };

    const hosted = await startHostedServer({ dataDir, port: 0, isolated: true }, host);

    expect(asked[0]).toMatchObject({ isolated: true, host: "127.0.0.1", mdns: false, relay: null });
    expect(host.relayServers.size).toBe(0);
    await hosted.stop();
  });
});
