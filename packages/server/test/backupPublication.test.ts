import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupWorkspace, verifyBackup } from "../src/backup.js";
import { createWorkspaceServer } from "../src/server.js";
import { holdFolder } from "../src/ownership.js";

const hooks = vi.hoisted(() => ({
  copy: null as ((from: string, to: string) => Promise<void> | void) | null,
  remove: null as ((path: string) => Promise<void> | void) | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fsPromises>();
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await hooks.copy?.(String(args[0]), String(args[1]));
      return actual.copyFile(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await hooks.remove?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});

let root: string;
let dataDir: string;
let fileId: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tandem-backup-publication-"));
  dataDir = join(root, "workspace");
  const server = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    });
    const owner = (await response.json()) as { user: { id: string } };
    fileId = server.store.createFile({
      channelId: server.store.getChannelByName("general")!.id,
      userId: owner.user.id,
      name: "kept.txt",
      mime: "text/plain",
      size: 4,
      width: null,
      height: null,
    }).id;
    writeFileSync(join(dataDir, "files", fileId), "kept");
  } finally {
    await server.stop();
  }
});
afterEach(() => {
  hooks.copy = null;
  hooks.remove = null;
  rmSync(root, { recursive: true, force: true });
});
const operations = () => readdirSync(root).filter((name) => name.startsWith(".gatherline-backup-"));

describe("publishing a verified backup", () => {
  it("keeps the destination unpublished until its attachments have been copied and verified", async () => {
    const out = join(root, "backup");
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let copying = false;
    hooks.copy = async () => {
      copying = true;
      await gate;
    };
    const pending = backupWorkspace({ dataDir, out });
    await vi.waitFor(() => expect(copying).toBe(true));
    expect(existsSync(out)).toBe(false);
    resume();
    await pending;
    await expect(verifyBackup(out)).resolves.toMatchObject({ files: [{ name: fileId }] });
    expect(operations()).toEqual([]);
  });

  it("cleans every failed snapshot, preserves an existing empty destination and can retry", async () => {
    const out = join(root, "backup");
    mkdirSync(out);
    hooks.copy = () => {
      throw new Error("ENOENT: attachment disappeared during capture");
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(backupWorkspace({ dataDir, out })).rejects.toThrow(/attachment disappeared/);
      expect(readdirSync(out)).toEqual([]);
      expect(operations()).toEqual([]);
    }
    hooks.copy = null;
    await backupWorkspace({ dataDir, out });
    await expect(verifyBackup(out)).resolves.toBeDefined();
  });

  it("preserves destination contents present before capture or added during it", async () => {
    const out = join(root, "backup");
    mkdirSync(out);
    const kept = join(out, "my-file.txt");
    writeFileSync(kept, "mine");
    await expect(backupWorkspace({ dataDir, out })).rejects.toThrow(/not empty/);
    expect(readFileSync(kept, "utf8")).toBe("mine");
    rmSync(kept);
    hooks.copy = () => {
      writeFileSync(kept, "added while copying");
    };
    await expect(backupWorkspace({ dataDir, out })).rejects.toThrow();
    expect(readFileSync(kept, "utf8")).toBe("added while copying");
    expect(operations()).toEqual([]);
  });

  it("reports cleanup failure and reconciles only its abandoned operation on the next retry", async () => {
    const out = join(root, "backup");
    hooks.copy = () => {
      throw new Error("ENOSPC: copying attachment");
    };
    hooks.remove = (path) => {
      if (path.includes(".gatherline-backup-")) throw new Error("EACCES: staging is locked");
    };
    const failure = await backupWorkspace({ dataDir, out }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "ENOSPC: copying attachment",
      "EACCES: staging is locked",
    ]);
    expect(existsSync(out)).toBe(false);
    expect(operations()).toHaveLength(1);
    const unknown = join(root, `.gatherline-backup-${randomUUID()}`);
    mkdirSync(unknown);
    writeFileSync(join(unknown, "mine.txt"), "keep");
    hooks.copy = null;
    hooks.remove = null;
    await backupWorkspace({ dataDir, out });
    expect(operations()).toEqual([unknown.slice(root.length + 1)]);
    expect(readFileSync(join(unknown, "mine.txt"), "utf8")).toBe("keep");
    await expect(verifyBackup(out)).resolves.toBeDefined();
  });

  it("skips a live operation and cleans interrupted staging after its owner releases it", async () => {
    const id = randomUUID();
    const operation = join(root, `.gatherline-backup-${id}`);
    mkdirSync(join(operation, "capture"), { recursive: true });
    writeFileSync(join(operation, "capture", "workspace.db"), "interrupted snapshot");
    writeFileSync(
      join(operation, "operation.json"),
      JSON.stringify({
        kind: "gatherline.backup-capture",
        version: 1,
        id,
        dataDir: realpathSync(dataDir),
        out: join(realpathSync(root), "interrupted"),
        preserveEmpty: true,
      }),
    );
    const hold = holdFolder(operation, "a live backup");
    try {
      await backupWorkspace({ dataDir, out: join(root, "first") });
      expect(existsSync(join(operation, "capture", "workspace.db"))).toBe(true);
    } finally {
      hold.release();
    }
    await backupWorkspace({ dataDir, out: join(root, "second") });
    expect(existsSync(operation)).toBe(false);
    expect(readdirSync(join(root, "interrupted"))).toEqual([]);
    await expect(verifyBackup(join(root, "first"))).resolves.toBeDefined();
  });

  it("restores an empty destination removed by an interrupted publication and completes the next retry", async () => {
    const id = randomUUID();
    const operation = join(root, `.gatherline-backup-${id}`);
    const out = join(root, "interrupted");
    mkdirSync(join(operation, "capture"), { recursive: true });
    writeFileSync(
      join(operation, "operation.json"),
      JSON.stringify({
        kind: "gatherline.backup-capture",
        version: 1,
        id,
        dataDir: realpathSync(dataDir),
        out: join(realpathSync(root), "interrupted"),
        preserveEmpty: true,
      }),
    );
    await backupWorkspace({ dataDir, out });
    expect(operations()).toEqual([]);
    await expect(verifyBackup(out)).resolves.toBeDefined();
  });

  it("reconciles a real process killed after snapshotting without publishing its unfinished copy", async () => {
    const out = join(root, "interrupted");
    mkdirSync(out);
    const script = join(root, "interrupted-capture.mjs");
    writeFileSync(
      script,
      `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const keepAlive = setInterval(() => {}, 1000);
      fs.copyFile = async () => {
        process.send("snapshot-ready");
        await new Promise(() => {});
      };
      syncBuiltinESMExports();
      const { backupWorkspace } = await import(${JSON.stringify(new URL("../src/backup.ts", import.meta.url).href)});
      await backupWorkspace(${JSON.stringify({ dataDir, out })});
      clearInterval(keepAlive);
    `,
    );
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, script],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-4000);
    });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("capture child did not reach its snapshot")),
          10_000,
        );
        child.once("message", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`capture exited early: ${code}: ${stderr}`));
        });
      });
      expect(operations()).toHaveLength(1);
      expect(existsSync(join(root, operations()[0]!, "capture", "workspace.db"))).toBe(true);
      expect(readdirSync(out)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
    await backupWorkspace({ dataDir, out });
    expect(operations()).toEqual([]);
    await expect(verifyBackup(out)).resolves.toBeDefined();
  }, 15_000);
});
