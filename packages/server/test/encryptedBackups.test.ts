import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupWorkspace, restoreWorkspace, verifyBackup } from "../src/backups/backup.js";
import {
  backupFolderName,
  backupInChildProcess,
  listScheduledBackups,
} from "../src/backups/backupSchedule.js";
import type { BackupEncryption } from "../src/backups/encryption.js";
import { OffsiteBackups, parseOffsiteUrl } from "../src/backups/offsite.js";
import {
  ENCRYPTED_SUFFIX,
  PASSPHRASE_NEEDED,
  readSealedManifest,
  withAnyBackupFolder,
} from "../src/backups/sealed.js";
import { ConfigError, parseBackupPassphrase } from "../src/config.js";
import { createWorkspaceServer, type ServerOptions, type WorkspaceServer } from "../src/server.js";

const PASSPHRASE = "correct horse battery staple";
/** Cheap enough for a test; the real cost is checked by the command-line tests. */
const SEALED: BackupEncryption = {
  passphrase: PASSPHRASE,
  cost: { log2N: 10, r: 8, p: 1 },
  chunkBytes: 4096,
};
const SECRET_TEXT = "the launch date moves to friday";
const FILE_NAME = "quarterly-invoice.txt";
const FILE_TEXT = "invoice body that stays private";
const HOUR = 3600_000;
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

let server: WorkspaceServer | undefined;
let root: string;
let dataDir: string;
let base: string;

async function start(dir: string, extra: Partial<ServerOptions> = {}) {
  server = await createWorkspaceServer({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    workspaceName: "Sealed Away",
    ...extra,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function api(path: string, token?: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** A stopped workspace with an owner, a message and a file worth hiding. */
async function populated(): Promise<void> {
  await start(dataDir);
  const { token } = (
    await api("/api/auth/register", undefined, "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    })
  ).body;
  const channelId = server!.store.channels.byName("general")!.id;
  const form = new FormData();
  form.append("file", new Blob([FILE_TEXT]), FILE_NAME);
  const uploaded = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const { file } = (await uploaded.json()) as { file: { id: string } };
  await api(`/api/channels/${channelId}/messages`, token, "POST", {
    text: SECRET_TEXT,
    fileIds: [file.id],
  });
  await server!.stop();
  server = undefined;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ownbase-encrypted-backups-"));
  dataDir = join(root, "data");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.stop();
  server = undefined;
  await bucket?.close();
  bucket = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** Why `promise` failed: a wrong passphrase, damage, or the message. */
async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { reason?: string }).reason ?? String(error);
  }
  return "succeeded";
}

describe("taking an encrypted backup", () => {
  it("writes one file that holds no message, file name or file text", async () => {
    await populated();
    const out = join(root, `b${ENCRYPTED_SUFFIX}`);
    const manifest = await backupWorkspace({ dataDir, out, encryption: SEALED });
    expect(manifest.files).toHaveLength(1);
    expect(readdirSync(root).sort()).toEqual(["b.encrypted", "data"]);
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 25).toString("latin1")).toBe("OwnBase encrypted backup\n");
    for (const plain of [SECRET_TEXT, FILE_NAME, FILE_TEXT, "Sealed Away", "manifest.json"]) {
      expect(bytes.includes(Buffer.from(plain)), plain).toBe(false);
      expect(bytes.includes(Buffer.from(plain, "utf16le")), plain).toBe(false);
    }
    expect((await readSealedManifest(out, PASSPHRASE)).createdAt).toBe(manifest.createdAt);
  }, 30_000);

  it("refuses a name something already has", async () => {
    await populated();
    const out = join(root, "taken.encrypted");
    writeFileSync(out, "keep me");
    await expect(backupWorkspace({ dataDir, out, encryption: SEALED })).rejects.toThrow(
      "already exists",
    );
    expect(readFileSync(out, "utf8")).toBe("keep me");
  }, 30_000);
});

describe("reading an encrypted backup back", () => {
  it("verifies, restores, and the restored workspace signs in", async () => {
    await populated();
    const out = join(root, "b.encrypted");
    await backupWorkspace({ dataDir, out, encryption: SEALED });
    const restored = join(root, "restored");
    await withAnyBackupFolder(out, PASSPHRASE, async (dir, info) => {
      expect(info.encrypted).toBe(true);
      expect((await verifyBackup(dir)).workspaceName).toBe("Sealed Away");
      await restoreWorkspace({ backupDir: dir, dataDir: restored });
    });
    // What was decrypted is gone again.
    expect(readdirSync(root).sort()).toEqual(["b.encrypted", "data", "restored"]);
    await start(restored);
    const login = await api("/api/auth/login", undefined, "POST", {
      handle: "owner",
      password: "password123",
    });
    expect(login.status).toBe(200);
    const channelId = server!.store.channels.byName("general")!.id;
    const { messages } = (await api(`/api/channels/${channelId}/messages`, login.body.token)).body;
    expect(messages.map((m: { text: string }) => m.text)).toContain(SECRET_TEXT);
  }, 30_000);

  it("asks for the passphrase, and refuses a wrong one or a damaged file before using it", async () => {
    await populated();
    const out = join(root, "b.encrypted");
    await backupWorkspace({ dataDir, out, encryption: SEALED });
    const use = vi.fn(async () => undefined);
    await expect(withAnyBackupFolder(out, undefined, use)).rejects.toThrow(PASSPHRASE_NEEDED);
    expect(await reason(withAnyBackupFolder(out, "not the passphrase at all", use))).toBe(
      "passphrase",
    );
    const bytes = readFileSync(out);
    for (const at of [bytes.length >> 1, bytes.length - 1]) {
      const flipped = Buffer.from(bytes);
      flipped[at]! ^= 0x40;
      const damagedFile = join(root, `flipped-${at}.encrypted`);
      writeFileSync(damagedFile, flipped);
      expect(await reason(withAnyBackupFolder(damagedFile, PASSPHRASE, use)), `byte ${at}`).toBe(
        "damaged",
      );
    }
    const cut = join(root, "cut.encrypted");
    writeFileSync(cut, bytes.subarray(0, bytes.length - 4096));
    expect(await reason(withAnyBackupFolder(cut, PASSPHRASE, use))).toBe("damaged");
    expect(use).not.toHaveBeenCalled();
    expect(readdirSync(root).filter((name) => name.startsWith(".ownbase-decrypt-"))).toEqual([]);
  }, 30_000);

  it("still reads a plain backup, passphrase or not", async () => {
    await populated();
    const out = join(root, "plain");
    await backupWorkspace({ dataDir, out });
    for (const passphrase of [undefined, PASSPHRASE]) {
      await withAnyBackupFolder(out, passphrase, async (dir, info) => {
        expect(info.encrypted).toBe(false);
        expect((await verifyBackup(dir)).files).toHaveLength(1);
      });
    }
  }, 30_000);
});

describe("scheduled encrypted backups", () => {
  const schedule = (encryption?: BackupEncryption) => ({
    scheduledBackups: {
      dir: join(root, "backups"),
      everyMs: 24 * HOUR,
      keep: 2,
      firstDelayMs: 0,
      encryption,
    },
  });

  it("counts plain folders and encrypted files alike, and nothing else", async () => {
    const dir = join(root, "backups");
    const day = (d: number) => backupFolderName(Date.UTC(2026, 10, d));
    mkdirSync(join(dir, day(1)), { recursive: true });
    writeFileSync(join(dir, day(2) + ENCRYPTED_SUFFIX), "");
    mkdirSync(join(dir, day(3) + ENCRYPTED_SUFFIX)); // a folder by that name is not ours
    writeFileSync(join(dir, day(4)), ""); // nor a file without the suffix
    writeFileSync(join(dir, "notes.encrypted"), "");
    expect((await listScheduledBackups(dir)).map((b) => b.name)).toEqual([
      day(1),
      day(2) + ENCRYPTED_SUFFIX,
    ]);
  });

  it("seals each one, and prunes the plain ones from before in their turn", async () => {
    await populated();
    const dir = join(root, "backups");
    for (const d of [1, 2]) {
      await backupWorkspace({ dataDir, out: join(dir, backupFolderName(Date.UTC(2026, 9, d))) });
    }
    await start(dataDir, schedule(SEALED));
    // The status counts the older folders as successes already, so wait on
    // the folder: the new one published and the oldest pruned.
    let kept: { name: string }[] = [];
    await vi.waitFor(
      async () => {
        kept = await listScheduledBackups(dir);
        expect(kept.map((b) => b.name)).toEqual([
          backupFolderName(Date.UTC(2026, 9, 2)),
          expect.stringMatching(/^backup-.*Z\.encrypted$/),
        ]);
      },
      { timeout: 20_000, interval: 100 },
    );
    const sealed = join(dir, kept[1]!.name);
    expect((await readSealedManifest(sealed, PASSPHRASE)).workspaceName).toBe("Sealed Away");
  }, 30_000);

  it("takes plain ones when no passphrase is set", async () => {
    await populated();
    const dir = join(root, "backups");
    const taken: (BackupEncryption | undefined)[] = [];
    await start(dataDir, {
      ...schedule(),
      takeBackup: async (out, _signal, encryption) => {
        taken.push(encryption);
        return backupWorkspace({ dataDir, out, encryption });
      },
    });
    await vi.waitFor(
      () => expect(server!.backupStatus()?.lastSuccessAt).toEqual(expect.any(Number)),
      {
        timeout: 20_000,
      },
    );
    expect(taken).toEqual([undefined]);
    const [only] = await listScheduledBackups(dir);
    expect(only!.name.endsWith(ENCRYPTED_SUFFIX)).toBe(false);
  }, 30_000);
});

describe("an encrypted backup in a child process", () => {
  const run = () => backupInChildProcess({ script: main, dataDir, execArgv: ["--import", "tsx"] });

  it("seals with the passphrase it is given, and only then", async () => {
    await populated();
    const out = join(root, "child.encrypted");
    const manifest = await run()(out, new AbortController().signal, { passphrase: PASSPHRASE });
    expect(manifest.files).toHaveLength(1);
    expect(readFileSync(out).subarray(0, 7).toString()).toBe("OwnBase");
    // This process's own passphrase does not reach a backup asked for plain.
    vi.stubEnv("OWNBASE_BACKUP_PASSPHRASE", PASSPHRASE);
    const plain = join(root, "child-plain");
    await run()(plain, new AbortController().signal);
    expect((await verifyBackup(plain)).files).toHaveLength(1);
  }, 60_000);
});

/** Just enough of S3 for an upload and a listing; signatures are checked in offsite.test.ts. */
interface FakeBucket {
  url: string;
  objects: Map<string, { body: Buffer; type: string }>;
  close: () => Promise<void>;
}
let bucket: FakeBucket | undefined;

async function fakeBucket(): Promise<FakeBucket> {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    const body = await read(req);
    const key = url.pathname.split("/").slice(2).map(decodeURIComponent).join("/");
    if (req.method === "PUT") {
      objects.set(key, { body, type: String(req.headers["content-type"]) });
      res.writeHead(200, { etag: '"whole"' }).end();
    } else if (req.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      res.end(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${keys
          .map((k) => `<Contents><Key>${k}</Key></Contents>`)
          .join("")}</ListBucketResult>`,
      );
    } else if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/backups`,
    objects,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}

const offsite = (url: string, keep = 3) =>
  new OffsiteBackups(
    {
      ...parseOffsiteUrl(url),
      region: "auto",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "a-test-secret",
    },
    keep,
    { retryDelaysMs: [1, 1] },
  );

describe("encrypted offsite copies", () => {
  it("sends the encrypted file as it is, and it restores", async () => {
    bucket = await fakeBucket();
    await populated();
    const name = backupFolderName(Date.UTC(2026, 10, 4)) + ENCRYPTED_SUFFIX;
    const file = join(root, name);
    await backupWorkspace({ dataDir, out: file, encryption: SEALED });
    const sent = await offsite(`${bucket.url}/acme`).upload(file, name);
    expect(sent.key).toBe(`acme/${name}`);
    const object = bucket.objects.get(sent.key)!;
    expect(object.type).toBe("application/octet-stream");
    expect(object.body.equals(readFileSync(file))).toBe(true);
    const downloaded = join(root, "downloaded.encrypted");
    writeFileSync(downloaded, object.body);
    await withAnyBackupFolder(downloaded, PASSPHRASE, async (dir) => {
      expect((await verifyBackup(dir)).workspaceName).toBe("Sealed Away");
    });
  }, 30_000);

  it("prunes encrypted and plain copies together, and nothing it did not write", async () => {
    bucket = await fakeBucket();
    const day = (d: number) => backupFolderName(Date.UTC(2026, 10, d));
    const ours = [
      `t/${day(1)}.zip`,
      `t/${day(2)}.encrypted`,
      `t/${day(3)}.zip`,
      `t/${day(4)}.encrypted`,
    ];
    for (const key of [...ours, "t/notes.encrypted", `t/${day(1)}.zip.encrypted`])
      bucket.objects.set(key, { body: Buffer.from("x"), type: "" });
    expect(await offsite(`${bucket.url}/t`, 2).prune()).toEqual(ours.slice(0, 2));
    expect([...bucket.objects.keys()].sort()).toEqual(
      [...ours.slice(2), "t/notes.encrypted", `t/${day(1)}.zip.encrypted`].sort(),
    );
  });
});

describe("the backup passphrase setting", () => {
  const parse = (direct?: string, file?: string, contents?: string) =>
    parseBackupPassphrase({
      direct,
      file,
      readFile: () => {
        if (contents === undefined) throw Object.assign(new Error("no"), { code: "ENOENT" });
        return contents;
      },
    });

  it("is off when nothing is set", () => {
    expect(parse()).toBeUndefined();
  });

  it("comes from the variable, or a file without its last line break", () => {
    expect(parse(PASSPHRASE)).toBe(PASSPHRASE);
    expect(parse(undefined, "p.txt", `${PASSPHRASE}\r\n`)).toBe(PASSPHRASE);
    expect(parse(undefined, "p.txt", `  ${PASSPHRASE} \n`)).toBe(`  ${PASSPHRASE} `);
  });

  it("refuses both at once, an empty or short one, and a file it cannot read", () => {
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).not.toContain(PASSPHRASE);
        return (error as Error).message;
      }
      return "accepted";
    };
    expect(refusal(() => parse(PASSPHRASE, "p.txt", PASSPHRASE))).toContain("not both");
    expect(refusal(() => parse(""))).toContain("empty backup passphrase");
    expect(refusal(() => parse(undefined, "p.txt", "   \n"))).toContain("empty backup passphrase");
    expect(refusal(() => parse("eleven char"))).toContain("at least 12 characters");
    expect(refusal(() => parse(undefined, "missing.txt"))).toContain("could not read");
    expect(refusal(() => parse(undefined, " "))).toContain("needs the path");
  });
});

describe("the command line", () => {
  function cli(args: string[], env: Record<string, string> = {}) {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    if (!("OWNBASE_BACKUP_PASSPHRASE" in env)) delete childEnv.OWNBASE_BACKUP_PASSPHRASE;
    const child = spawn(process.execPath, ["--import", "tsx", main, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (output += String(chunk)));
    return new Promise<{ code: number | null; output: string }>((resolve) =>
      child.once("exit", (code) => resolve({ code, output })),
    );
  }

  it("takes, verifies and restores an encrypted backup, and never prints the passphrase", async () => {
    await populated();
    const withPassphrase = { OWNBASE_BACKUP_PASSPHRASE: PASSPHRASE };
    const taken = await cli(
      ["backup", "--data", dataDir, "--out", join(root, "b")],
      withPassphrase,
    );
    expect(taken.code, taken.output).toBe(0);
    expect(taken.output).toContain(`b${ENCRYPTED_SUFFIX}`);
    expect(taken.output).toContain("Without it, nobody can restore it");
    const file = join(root, `b${ENCRYPTED_SUFFIX}`);
    expect(existsSync(file)).toBe(true);

    const none = await cli(["verify-backup", "--from", file]);
    expect(none.code).toBe(1);
    expect(none.output).toContain("This backup is encrypted");

    const passphraseFile = join(root, "passphrase.txt");
    writeFileSync(passphraseFile, "a different passphrase\n");
    const wrong = await cli([
      "verify-backup",
      "--from",
      file,
      "--backup-passphrase-file",
      passphraseFile,
    ]);
    expect(wrong.code).toBe(1);
    expect(wrong.output).toContain("The backup passphrase is wrong");

    const verified = await cli(["verify-backup", "--from", file], withPassphrase);
    expect(verified.code, verified.output).toBe(0);
    expect(verified.output).toContain("is intact, and the passphrase opens it");

    const restored = await cli(
      ["restore", "--from", file, "--data", join(root, "restored")],
      withPassphrase,
    );
    expect(restored.code, restored.output).toBe(0);
    expect(existsSync(join(root, "restored", "workspace.db"))).toBe(true);
    for (const run of [taken, none, wrong, verified, restored])
      expect(run.output).not.toContain(PASSPHRASE);
  }, 90_000);

  it("refuses a passphrase too short before taking anything", async () => {
    await populated();
    const short = await cli(["backup", "--data", dataDir, "--out", join(root, "b")], {
      OWNBASE_BACKUP_PASSPHRASE: "short",
    });
    expect(short.code).toBe(1);
    expect(short.output).toContain("at least 12 characters");
    expect(short.output).not.toContain("short\n");
    expect(existsSync(join(root, "b.encrypted"))).toBe(false);
  }, 30_000);
});
