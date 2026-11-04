import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupWorkspace, verifyBackup } from "../src/backup.js";
import { BackupSchedule, backupFolderName } from "../src/backupSchedule.js";
import {
  OffsiteBackups,
  parseOffsiteUrl,
  pieces,
  signRequest,
  type OffsiteUploader,
} from "../src/offsite.js";
import { createWorkspaceServer } from "../src/server.js";
import { unzipBackup } from "../src/workspaceCopy.js";
import { Readable } from "node:stream";

const HOUR = 3600_000;
const KEYS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "a-secret-that-stays-here" };
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ownbase-offsite-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await bucket?.close();
  bucket = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("request signing", () => {
  // The worked examples in AWS's "Signature Calculations for the
  // Authorization Header" for S3.
  const aws = {
    host: "examplebucket.s3.amazonaws.com",
    at: new Date("2013-05-24T00:00:00Z"),
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };

  it("matches AWS's example of getting an object", () => {
    const headers = signRequest({
      ...aws,
      method: "GET",
      path: "/test.txt",
      headers: { range: "bytes=0-9" },
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });

  it("matches AWS's example of listing objects, query and all", () => {
    const headers = signRequest({
      ...aws,
      method: "GET",
      path: "/",
      query: { prefix: "J", "max-keys": "2" },
    });
    expect(headers.authorization).toContain(
      "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("the bucket address", () => {
  it("takes the host, the bucket and a folder within it", () => {
    expect(parseOffsiteUrl("https://acct.r2.cloudflarestorage.com/ownbase-backups")).toEqual({
      origin: "https://acct.r2.cloudflarestorage.com",
      bucket: "ownbase-backups",
      prefix: "",
    });
    expect(parseOffsiteUrl("https://acct.r2.cloudflarestorage.com/b/teams/acme/")).toMatchObject({
      bucket: "b",
      prefix: "teams/acme/",
    });
  });

  it("refuses plain http elsewhere, keys in the address, and a missing bucket", () => {
    expect(() => parseOffsiteUrl("http://example.com/b")).toThrow("https://");
    expect(() => parseOffsiteUrl("https://key:secret@example.com/b")).toThrow(
      "OWNBASE_BACKUP_OFFSITE",
    );
    expect(() => parseOffsiteUrl("https://example.com/")).toThrow("needs the bucket");
    expect(parseOffsiteUrl("http://127.0.0.1:9000/b").origin).toBe("http://127.0.0.1:9000");
  });
});

describe("pieces", () => {
  it("cuts a stream into equal pieces and the rest", async () => {
    const stream = Readable.from([Buffer.alloc(3, 1), Buffer.alloc(9, 2), Buffer.alloc(1, 3)]);
    const sizes: number[] = [];
    for await (const piece of pieces(stream, 5)) sizes.push(piece.length);
    expect(sizes).toEqual([5, 5, 3]);
  });
});

/**
 * Just enough of S3 for these tests, in memory. Every request's signature is
 * worked out again from what arrived, so what is sent must be what was signed.
 */
interface FakeBucket {
  url: string;
  objects: Map<string, Buffer>;
  requests: string[];
  /** Answers the next requests with these statuses first. */
  failNext: number[];
  close: () => Promise<void>;
}
let bucket: FakeBucket | undefined;

async function fakeBucket(name = "backups"): Promise<FakeBucket> {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const requests: string[] = [];
  const failNext: number[] = [];
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    const query = Object.fromEntries(url.searchParams);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const data = await body(req);
    const auth = String(req.headers.authorization);
    const signed = /SignedHeaders=([^,]+)/.exec(auth)![1]!.split(";");
    const amzDate = String(req.headers["x-amz-date"]);
    const expected = signRequest({
      method: req.method!,
      host: String(req.headers.host),
      path: url.pathname,
      query,
      headers: Object.fromEntries(
        signed
          .filter((h) => !["host", "x-amz-date", "x-amz-content-sha256"].includes(h))
          .map((h) => [h, String(req.headers[h])]),
      ),
      payloadHash: String(req.headers["x-amz-content-sha256"]),
      at: new Date(
        `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
      ),
      region: "auto",
      ...KEYS,
    }).authorization;
    const hash = (await import("node:crypto")).createHash("sha256").update(data).digest("hex");
    if (auth !== expected || hash !== req.headers["x-amz-content-sha256"]) {
      res
        .writeHead(403)
        .end("<Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>");
      return;
    }
    const status = failNext.shift();
    if (status) {
      res.writeHead(status).end("<Error><Code>Nope</Code><Message>Not today</Message></Error>");
      return;
    }
    const [, bucketName, ...rest] = url.pathname.split("/");
    if (bucketName !== name) {
      res.writeHead(404).end("<Error><Code>NoSuchBucket</Code><Message>none</Message></Error>");
      return;
    }
    const key = rest.map(decodeURIComponent).join("/");
    if (req.method === "GET" && !key) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(query.prefix ?? "")).sort();
      res.end(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${keys
          .map((k) => `<Contents><Key>${k.replaceAll("&", "&amp;")}</Key></Contents>`)
          .join("")}</ListBucketResult>`,
      );
    } else if (req.method === "POST" && "uploads" in query) {
      const id = `upload-${uploads.size + 1}`;
      uploads.set(id, new Map());
      res.end(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    } else if (req.method === "PUT" && query.uploadId) {
      uploads.get(query.uploadId)!.set(Number(query.partNumber), data);
      res.writeHead(200, { etag: `"part-${query.partNumber}"` }).end();
    } else if (req.method === "POST" && query.uploadId) {
      const parts = uploads.get(query.uploadId)!;
      const numbers = [...String(data).matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(
        (m) => +m[1]!,
      );
      objects.set(key, Buffer.concat(numbers.map((n) => parts.get(n)!)));
      uploads.delete(query.uploadId);
      res.end("<CompleteMultipartUploadResult/>");
    } else if (req.method === "DELETE" && query.uploadId) {
      uploads.delete(query.uploadId);
      res.writeHead(204).end();
    } else if (req.method === "PUT") {
      objects.set(key, data);
      res.writeHead(200, { etag: '"whole"' }).end();
    } else if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/${name}`,
    objects,
    requests,
    failNext,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function offsite(
  url: string,
  keep = 3,
  extra: ConstructorParameters<typeof OffsiteBackups>[2] = {},
) {
  return new OffsiteBackups({ ...parseOffsiteUrl(url), region: "auto", ...KEYS }, keep, {
    retryDelaysMs: [1, 1],
    ...extra,
  });
}

/** A real backup of a fresh workspace. */
async function realBackup(): Promise<string> {
  const dataDir = join(root, "data");
  const server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    workspaceName: "Sent Away",
  });
  await server.stop();
  const out = join(root, "local", backupFolderName(Date.UTC(2026, 10, 4, 3)));
  await backupWorkspace({ dataDir, out });
  return out;
}

describe("offsite copies", () => {
  it("sends a backup as one zip that restores", async () => {
    bucket = await fakeBucket();
    const dir = await realBackup();
    const name = backupFolderName(Date.UTC(2026, 10, 4, 3));
    const sent = await offsite(`${bucket.url}/acme`).upload(dir, name);
    expect(sent.key).toBe(`acme/${name}.zip`);
    expect(bucket.requests).toEqual([`PUT /backups/acme/${name}.zip`]);
    const zip = join(root, "downloaded.zip");
    writeFileSync(zip, bucket.objects.get(sent.key)!);
    await unzipBackup(zip, join(root, "restored"));
    expect((await verifyBackup(join(root, "restored"))).workspaceName).toBe("Sent Away");
  }, 30_000);

  it("sends a large one in equal parts, and the parts make the same zip", async () => {
    bucket = await fakeBucket();
    const dir = await realBackup();
    const name = backupFolderName(Date.UTC(2026, 10, 4, 3));
    await offsite(bucket.url).upload(dir, name);
    const whole = bucket.objects.get(`${name}.zip`)!;
    bucket.requests.length = 0;
    await offsite(`${bucket.url}/parts`, 3, { partBytes: 64 * 1024 }).upload(dir, name);
    expect(bucket.objects.get(`parts/${name}.zip`)!.equals(whole)).toBe(true);
    const parts = bucket.requests.filter((r) => r.includes("partNumber="));
    expect(parts.length).toBe(Math.ceil(whole.length / (64 * 1024)));
    expect(bucket.requests[0]).toMatch(/^POST .*\?uploads$/);
    expect(bucket.requests.at(-1)).toMatch(/^POST .*\?uploadId=/);
  }, 30_000);

  it("keeps the newest few and removes nothing it did not write", async () => {
    bucket = await fakeBucket();
    const days = [1, 2, 3, 4, 5].map((d) => `team/${backupFolderName(Date.UTC(2026, 10, d))}.zip`);
    for (const key of days) bucket.objects.set(key, Buffer.from("zip"));
    for (const key of [
      "team/backup-notes.zip",
      "team/backup-x/y.zip",
      "other/" + days[0]!.slice(5),
    ])
      bucket.objects.set(key, Buffer.from("keep me"));
    const removed = await offsite(`${bucket.url}/team`, 2).prune();
    expect(removed).toEqual(days.slice(0, 3));
    expect([...bucket.objects.keys()].sort()).toEqual(
      [
        ...days.slice(3),
        "team/backup-notes.zip",
        "team/backup-x/y.zip",
        "other/" + days[0]!.slice(5),
      ].sort(),
    );
  });

  it("tries a server error again, and says what a refusal was without trying again", async () => {
    bucket = await fakeBucket();
    const dir = await realBackup();
    const name = backupFolderName(Date.UTC(2026, 10, 4, 3));
    bucket.failNext.push(503, 500);
    await offsite(bucket.url).upload(dir, name);
    expect(bucket.objects.has(`${name}.zip`)).toBe(true);

    bucket.requests.length = 0;
    bucket.failNext.push(403);
    const failure = offsite(bucket.url).upload(dir, name);
    await expect(failure).rejects.toThrow("Offsite copy: PUT was refused with 403 Nope: Not today");
    await expect(failure).rejects.not.toThrow(KEYS.secretAccessKey);
    expect(bucket.requests).toHaveLength(1);
  }, 30_000);

  it("is refused by a bucket that holds other keys", async () => {
    bucket = await fakeBucket();
    const dir = await realBackup();
    const wrong = new OffsiteBackups(
      {
        ...parseOffsiteUrl(bucket.url),
        region: "auto",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wrong",
      },
      3,
    );
    await expect(wrong.upload(dir, backupFolderName(Date.UTC(2026, 10, 4)))).rejects.toThrow(
      "403 SignatureDoesNotMatch",
    );
  }, 30_000);
});

describe("the schedule with offsite copies", () => {
  const log = { info: () => {}, error: () => {} };

  function scheduled(uploader: OffsiteUploader) {
    const dir = join(root, "local");
    return new BackupSchedule({
      dir,
      everyMs: 24 * HOUR,
      keep: 7,
      firstDelayMs: 24 * HOUR,
      offsite: uploader,
      log,
      run: async (out) => {
        mkdirSync(join(out, "files"), { recursive: true });
        return { files: [] } as never;
      },
    });
  }

  it("counts a failed send apart from the backup, and sends it again within the hour", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 4, 3));
    const sent: string[] = [];
    let failing = true;
    const schedule = scheduled({
      where: "test",
      keep: 3,
      upload: async (_dir, name) => {
        if (failing) throw new Error("Offsite copy: PUT was refused with 403 AccessDenied");
        sent.push(name);
        return { key: name, bytes: 1 };
      },
      prune: async () => [],
    });
    await schedule.start();
    await schedule.runNow();
    let status = schedule.status();
    expect(status.failures).toBe(0);
    expect(status.lastSuccessAt).toBe(Date.UTC(2026, 10, 4, 3));
    expect(status.offsite).toEqual({
      lastSuccessAt: null,
      lastError: "Offsite copy: PUT was refused with 403 AccessDenied",
      failures: 1,
    });

    failing = false;
    await vi.advanceTimersByTimeAsync(HOUR);
    // The retry first looks on disk that the backup is still there.
    await vi.waitFor(() => expect(sent).toEqual([backupFolderName(Date.UTC(2026, 10, 4, 3))]));
    status = schedule.status();
    expect(status.offsite).toEqual({
      lastSuccessAt: Date.UTC(2026, 10, 4, 3),
      lastError: null,
      failures: 0,
    });
    // The retry took no second backup.
    expect(status.lastSuccessAt).toBe(Date.UTC(2026, 10, 4, 3));
    await schedule.stop();
  });

  it("says nothing of offsite copies when there are none", async () => {
    const schedule = new BackupSchedule({
      dir: join(root, "local"),
      everyMs: HOUR,
      keep: 1,
      log,
      run: async () => ({ files: [] }) as never,
    });
    expect(schedule.status().offsite).toBeNull();
  });
});

describe("the command line", () => {
  function cli(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", main, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (output += String(chunk)));
    return {
      child,
      output: () => output,
      exited: new Promise<number | null>((resolve) => child.once("exit", resolve)),
    };
  }
  const base = () => [
    "--data",
    join(root, "data"),
    "--port",
    "0",
    "--host",
    "127.0.0.1",
    "--no-mdns",
  ];

  it("refuses an offsite bucket without keys, or without --backup-dir", async () => {
    const noKeys = cli([
      ...base(),
      "--backup-dir",
      join(root, "b"),
      "--backup-offsite",
      "https://h.example/b",
    ]);
    expect(await noKeys.exited).toBe(1);
    expect(noKeys.output()).toContain("OWNBASE_BACKUP_OFFSITE_ACCESS_KEY_ID");
    const noDir = cli([...base(), "--backup-offsite", "https://h.example/b"]);
    expect(await noDir.exited).toBe(1);
    expect(noDir.output()).toContain("--backup-offsite needs --backup-dir");
  }, 30_000);

  it("says where the copies go, and never the keys", async () => {
    const run = cli(
      [...base(), "--backup-dir", join(root, "b"), "--backup-offsite", "https://h.example/b/acme"],
      {
        OWNBASE_BACKUP_OFFSITE_ACCESS_KEY_ID: KEYS.accessKeyId,
        OWNBASE_BACKUP_OFFSITE_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
      },
    );
    try {
      await vi.waitFor(() => expect(run.output()).toContain("Offsite:"), { timeout: 20_000 });
      expect(run.output()).toContain(
        "Offsite: each backup also goes to https://h.example/b/acme/, keeping 7",
      );
      expect(run.output()).not.toContain(KEYS.secretAccessKey);
    } finally {
      run.child.kill();
      await run.exited;
    }
  }, 30_000);
});
