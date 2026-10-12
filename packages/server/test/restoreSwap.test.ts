import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupWorkspace, restoreWorkspace } from "../src/backup.js";
import { WorkspaceInUseError } from "../src/ownership.js";
import { listAccounts } from "../src/recover.js";
import { createWorkspaceServer } from "../src/server.js";

/**
 * A restore lets go of the folder's own lock to move the old folder aside and
 * the restored one in, because Windows will not rename a folder with an open
 * file in it. Whatever asks for the workspace during that swap must be refused
 * all the same, or it makes itself a new workspace where the restored one was
 * going (Q01). This file runs something at each point of the swap, and can
 * fail the move that installs the restored copy.
 */
let root: string;
let dataDir: string;
let backupDir: string;

const during = {
  /** The staging folder has just been made. */
  staging: null as (() => Promise<void>) | null,
  /** The backup is staged and the old folder is about to be moved aside. */
  beforeAside: null as (() => Promise<void>) | null,
  /** The old folder is moved aside and nothing is at the path. */
  between: null as (() => Promise<void>) | null,
  /** Refuses the move that puts the restored copy at the path. */
  failInstall: null as NodeJS.ErrnoException | null,
};

/** Each is used once, so a restore started from inside one runs undisturbed. */
function take<K extends keyof typeof during>(name: K): (typeof during)[K] {
  const value = during[name];
  during[name] = null;
  return value;
}

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fsPromises>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const made = await actual.mkdtemp(...args);
      if (String(args[0]).includes(".restoring-")) await take("staging")?.();
      return made;
    },
    rename: async (from: string, to: string) => {
      const aside = from === dataDir;
      const install = to === dataDir && from.includes(".restoring-");
      if (aside) await take("beforeAside")?.();
      if (install) {
        const error = take("failInstall");
        if (error) throw error;
      }
      await actual.rename(from, to);
      if (aside) await take("between")?.();
    },
  };
});

async function register(port: number, handle: string) {
  await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
}

/** What a start on the workspace came to. A server that does start is stopped again. */
async function tryStart(): Promise<unknown> {
  try {
    const server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
    });
    await server.stop();
    return "started";
  } catch (error) {
    return error;
  }
}

const handles = (dir: string) =>
  listAccounts(dir)
    .map((account) => account.handle)
    .sort();
const leftovers = () =>
  readdirSync(root).filter((name) => name.includes(".restoring-") || name.includes(".superseded-"));

// The backup holds one account. The workspace gains a second afterwards, so
// the two can be told apart wherever they end up.
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "slackoss-restore-swap-"));
  dataDir = join(root, "workspace");
  backupDir = join(root, "backup");
  const first = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
  await register(first.port, "owner");
  await first.stop();
  await backupWorkspace({ dataDir, out: backupDir });
  const second = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
  await register(second.port, "later");
  await second.stop();
});

afterEach(() => {
  for (const name of Object.keys(during) as (keyof typeof during)[]) during[name] = null;
  rmSync(root, { recursive: true, force: true });
});

describe("a restore swapping folders", () => {
  it("refuses a server that starts while nothing is at the path, and finishes", async () => {
    let attempt: unknown;
    let folderThen: boolean | undefined;
    during.between = async () => {
      attempt = await tryStart();
      folderThen = existsSync(dataDir);
    };

    const { supersededDir } = await restoreWorkspace({ backupDir, dataDir });

    expect(attempt).toBeInstanceOf(WorkspaceInUseError);
    // The refused server made no folder of its own where the restored one goes.
    expect(folderThen).toBe(false);
    expect(handles(dataDir)).toEqual(["owner"]);
    expect(handles(supersededDir!)).toEqual(["later", "owner"]);
  });

  it("refuses a server that starts on the old folder just before it is moved aside", async () => {
    let attempt: unknown;
    during.beforeAside = async () => {
      attempt = await tryStart();
    };

    const { supersededDir } = await restoreWorkspace({ backupDir, dataDir });

    expect(attempt).toBeInstanceOf(WorkspaceInUseError);
    expect(handles(dataDir)).toEqual(["owner"]);
    expect(handles(supersededDir!)).toEqual(["later", "owner"]);
  });

  it("refuses a second restore of the same workspace", async () => {
    let attempt: unknown;
    during.between = async () => {
      attempt = await restoreWorkspace({ backupDir, dataDir }).catch((error: unknown) => error);
    };

    const { supersededDir } = await restoreWorkspace({ backupDir, dataDir });

    expect(attempt).toBeInstanceOf(WorkspaceInUseError);
    expect(handles(dataDir)).toEqual(["owner"]);
    // One copy moved aside, and nothing the second restore staged.
    expect(leftovers()).toEqual([supersededDir!.slice(root.length + 1)]);
  });

  it("refuses a server while a backup is staged for a folder that is not there", async () => {
    rmSync(dataDir, { recursive: true });
    let attempt: unknown;
    let folderThen: boolean | undefined;
    during.staging = async () => {
      attempt = await tryStart();
      folderThen = existsSync(dataDir);
    };

    const { supersededDir } = await restoreWorkspace({ backupDir, dataDir });

    expect(attempt).toBeInstanceOf(WorkspaceInUseError);
    expect(folderThen).toBe(false);
    expect(supersededDir).toBeNull();
    expect(handles(dataDir)).toEqual(["owner"]);
  });

  it("puts the original back when the restored copy cannot be moved in, and lets go", async () => {
    during.failInstall = Object.assign(new Error("EPERM: operation not permitted, rename"), {
      code: "EPERM",
    });

    await expect(restoreWorkspace({ backupDir, dataDir })).rejects.toThrow(/EPERM/);

    expect(readdirSync(root).sort()).toEqual(["backup", "workspace"]);
    expect(handles(dataDir)).toEqual(["later", "owner"]);
    expect(await tryStart()).toBe("started");
  });

  it("lets a server have the restored workspace once it is in place", async () => {
    const { supersededDir } = await restoreWorkspace({ backupDir, dataDir });
    // The copy moved aside is all the restore leaves beside the workspace.
    expect(readdirSync(root).sort()).toEqual(
      ["backup", "workspace", supersededDir!.slice(root.length + 1)].sort(),
    );
    expect(await tryStart()).toBe("started");
    expect(handles(dataDir)).toEqual(["owner"]);
  });
});
