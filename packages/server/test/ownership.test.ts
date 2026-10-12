import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupWorkspace, restoreWorkspace } from "../src/backup.js";
import {
  holdFolder,
  holdWorkspace,
  holdWorkspacePath,
  WORKSPACE_OWNER,
  WORKSPACE_PATH_LOCK,
  WorkspaceInUseError,
} from "../src/ownership.js";
import { listAccounts } from "../src/recover.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let root: string;
let dataDir: string;
const running: WorkspaceServer[] = [];

async function start(dir = dataDir, extra: { maxStorageBytes?: number; port?: number } = {}) {
  const server = await createWorkspaceServer({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    ...extra,
  });
  running.push(server);
  return server;
}

async function stop(server: WorkspaceServer) {
  running.splice(running.indexOf(server), 1);
  await server.stop();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slackoss-ownership-"));
  dataDir = join(root, "workspace");
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
  rmSync(root, { recursive: true, force: true });
});

describe("one workspace folder, one server", () => {
  it("refuses a second server on the same folder, and says which one has it", async () => {
    const first = await start();
    const refused = await start().catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(WorkspaceInUseError);
    expect((refused as WorkspaceInUseError).owner).toMatchObject({
      purpose: "a server",
      pid: process.pid,
      port: first.port,
    });
    expect((refused as Error).message).toContain(`port ${first.port}`);
  });

  it("lets exactly one of several servers started at once have the folder", async () => {
    const outcomes = await Promise.allSettled([start(), start(), start()]);
    const started = outcomes.filter((o) => o.status === "fulfilled");
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const outcome of refused) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(WorkspaceInUseError);
    }
  });

  it("cannot be used to pass the storage cap twice over", async () => {
    // Each server counted the folder's attachments separately, so each let a
    // four-byte upload in under a four-byte cap: eight bytes on disk.
    const first = await start(dataDir, { maxStorageBytes: 4 });
    await expect(start(dataDir, { maxStorageBytes: 4 })).rejects.toBeInstanceOf(
      WorkspaceInUseError,
    );
    const register = await fetch(`http://127.0.0.1:${first.port}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    });
    const { token } = (await register.json()) as { token: string };
    const channelId = first.store.getChannelByName("general")!.id;
    const upload = async () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(4)]), "four.bin");
      return (
        await fetch(`http://127.0.0.1:${first.port}/api/channels/${channelId}/files`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: form,
        })
      ).status;
    };
    expect(await upload()).toBe(201);
    expect(await upload()).not.toBe(201);
  });

  it.skipIf(process.platform === "win32")("finds the same folder by another path", async () => {
    await start();
    const alias = join(root, "alias");
    symlinkSync(dataDir, alias, "dir");
    await expect(start(alias)).rejects.toBeInstanceOf(WorkspaceInUseError);
    await expect(start(join(root, ".", "workspace", "..", "workspace"))).rejects.toBeInstanceOf(
      WorkspaceInUseError,
    );
  });

  it("lets the next server in once the first has stopped", async () => {
    const first = await start();
    await stop(first);
    expect(existsSync(join(dataDir, WORKSPACE_OWNER))).toBe(false);
    const second = await start();
    expect(second.port).toBeGreaterThan(0);
  });

  it("gives the folder back when a start fails part-way", async () => {
    // Something else is listening on the port this start asks for.
    const blocker = createServer();
    await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(start(dataDir, { port })).rejects.toThrow();
    } finally {
      await new Promise((done) => blocker.close(done));
    }
    await expect(start()).resolves.toBeDefined();
  });

  it("lets the next server in after the holder is killed, with no stale lock to clear", async () => {
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { holdWorkspace } from ${JSON.stringify(
          new URL("../src/ownership.ts", import.meta.url).href,
        )};
         // Kept, as a server keeps it: a hold nothing refers to is closed when collected.
         globalThis.hold = holdWorkspace(${JSON.stringify(dataDir)}, "a test holder");
         console.log("held");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((done, fail) => {
        holder.stdout!.once("data", () => done());
        holder.once("exit", (code) => fail(new Error(`holder exited with ${code}`)));
      });
      const refused = await start().catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(WorkspaceInUseError);
      expect((refused as WorkspaceInUseError).owner).toMatchObject({
        purpose: "a test holder",
        pid: holder.pid,
      });
    } finally {
      holder.kill("SIGKILL");
      await new Promise((done) => holder.once("exit", done));
    }
    // The owner description it left behind proves nothing, and is not asked to.
    await expect(start()).resolves.toBeDefined();
  });

  it("refuses to recover an account or restore a backup under a running server", async () => {
    const server = await start();
    const out = join(root, "backup");
    // Reading needs no hold: a backup of a running workspace still works.
    await backupWorkspace({ dataDir, out });

    expect(() => listAccounts(dataDir)).toThrow(WorkspaceInUseError);
    await expect(restoreWorkspace({ backupDir: out, dataDir })).rejects.toBeInstanceOf(
      WorkspaceInUseError,
    );
    // Nothing was moved aside or left half staged.
    expect(readdirSync(root).sort()).toEqual(["backup", "workspace"]);

    await stop(server);
    expect(listAccounts(dataDir)).toEqual([]);
    const { supersededDir } = await restoreWorkspace({ backupDir: out, dataDir });
    expect(supersededDir).not.toBeNull();
  });

  it("is released by its holder, and only once", () => {
    const hold = holdWorkspace(dataDir, "a test");
    expect(() => holdWorkspace(dataDir, "another")).toThrow(WorkspaceInUseError);
    hold.release();
    hold.release();
    holdWorkspace(dataDir, "another").release();
  });
});

describe("the path a workspace folder is at", () => {
  it("is held with no folder there, and nothing asking for the folder makes one", () => {
    const path = holdWorkspacePath(dataDir);
    expect(() => holdWorkspace(dataDir, "a test")).toThrow(WorkspaceInUseError);
    expect(() => holdWorkspacePath(dataDir)).toThrow(WorkspaceInUseError);
    expect(existsSync(dataDir)).toBe(false);

    path.release();
    path.release();
    holdWorkspace(dataDir, "a test").release();
  });

  it("leaves nothing beside the folder once it is let go", async () => {
    const lock = `${dataDir}${WORKSPACE_PATH_LOCK}`;
    const path = holdWorkspacePath(dataDir);
    expect(existsSync(lock)).toBe(true);
    path.release();
    expect(readdirSync(root)).toEqual([]);

    // Nor does taking the folder, which asks for the path on its way.
    const server = await start();
    expect(readdirSync(root)).toEqual(["workspace"]);
    await stop(server);
    expect(readdirSync(root)).toEqual(["workspace"]);
  });

  // What letting go relies on there: nobody can lock a file already removed.
  it.runIf(process.platform === "win32")("cannot have its file removed while held", () => {
    const lock = `${dataDir}${WORKSPACE_PATH_LOCK}`;
    const path = holdWorkspacePath(dataDir);
    expect(() => rmSync(lock)).toThrow();
    expect(() => holdWorkspacePath(dataDir)).toThrow(WorkspaceInUseError);
    path.release();
    expect(existsSync(lock)).toBe(false);
  });

  it("leaves a folder already held to its holder", () => {
    const hold = holdWorkspace(dataDir, "a test");
    // Asking for the path is not asking for the folder: a restore takes both.
    const path = holdWorkspacePath(dataDir);
    expect(() => holdFolder(dataDir, "a restore")).toThrow(WorkspaceInUseError);
    path.release();
    hold.release();
  });

  it("refuses a server while another process holds it, until that process is gone", async () => {
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { holdWorkspacePath } from ${JSON.stringify(
          new URL("../src/ownership.ts", import.meta.url).href,
        )};
         globalThis.hold = holdWorkspacePath(${JSON.stringify(dataDir)});
         console.log("held");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((done, fail) => {
        holder.stdout!.once("data", () => done());
        holder.once("exit", (code) => fail(new Error(`holder exited with ${code}`)));
      });
      await expect(start()).rejects.toBeInstanceOf(WorkspaceInUseError);
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      holder.kill("SIGKILL");
      await new Promise((done) => holder.once("exit", done));
    }
    await expect(start()).resolves.toBeDefined();
    // The file the killed holder left is gone with the next to hold the path.
    expect(readdirSync(root)).toEqual(["workspace"]);
  });

  it("does not stop a server where its lock cannot be kept", async () => {
    // Something else is where the lock's file would go.
    mkdirSync(`${dataDir}${WORKSPACE_PATH_LOCK}`, { recursive: true });
    await start();
    await expect(start()).rejects.toBeInstanceOf(WorkspaceInUseError);
  });
});
