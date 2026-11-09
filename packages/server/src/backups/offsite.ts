import { createHash, createHmac } from "node:crypto";
import type { Readable } from "node:stream";
import { backupFolderTime } from "./backupSchedule.js";
import { ConfigError } from "../config.js";
import { backupZipEntries } from "./workspaceCopy.js";
import { zipArchive } from "./zip.js";

/**
 * Offsite copies of scheduled backups: each verified backup also goes, as one
 * zip, to a bucket somewhere else, so a lost disk or machine does not take
 * the backups with it. Any S3-compatible store works; Cloudflare R2 is the one
 * this was tried against.
 *
 * The zip is the same one a downloaded workspace copy is, so restoring is
 * downloading it and running `restore --from <zip>`. Each backup is one
 * object, which keeps the requests a bucket bills for to a handful a day.
 * Requests are signed here (AWS Signature Version 4) with node:crypto, so no
 * SDK comes along.
 */

/** Where offsite copies go and how to sign in there. */
export interface OffsiteTarget {
  /** Scheme and host, such as https://<account>.r2.cloudflarestorage.com. */
  origin: string;
  bucket: string;
  /** Put before every name: empty, or ending in "/". */
  prefix: string;
  /** "auto" for R2; the bucket's region elsewhere. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the backup schedule needs from offsite copies. */
export interface OffsiteUploader {
  /** Where they go, without credentials, for the log and the start-up lines. */
  readonly where: string;
  readonly keep: number;
  /** Sends the backup folder `dir`, named `name`, as `<prefix><name>.zip`. */
  upload(dir: string, name: string, signal?: AbortSignal): Promise<{ key: string; bytes: number }>;
  /** Removes this schedule's oldest copies past `keep`, returning their keys. */
  prune(signal?: AbortSignal): Promise<string[]>;
}

/**
 * `https://<host>/<bucket>[/<prefix>]`, path-style. Plain http is taken only
 * for this machine, since the backup would cross the network unencrypted.
 */
export function parseOffsiteUrl(raw: string): Pick<OffsiteTarget, "origin" | "bucket" | "prefix"> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError(
      `--backup-offsite needs a URL like https://<host>/<bucket>, not "${raw}"`,
    );
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new ConfigError("--backup-offsite must be an https:// address");
  if (url.username || url.password || url.search || url.hash)
    throw new ConfigError(
      "--backup-offsite takes only the address and bucket; the keys go in OWNBASE_BACKUP_OFFSITE_ACCESS_KEY_ID and OWNBASE_BACKUP_OFFSITE_SECRET_ACCESS_KEY",
    );
  const [bucket, ...rest] = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (!bucket)
    throw new ConfigError(
      "--backup-offsite needs the bucket after the host: https://<host>/<bucket>",
    );
  return { origin: url.origin, bucket, prefix: rest.length ? `${rest.join("/")}/` : "" };
}

/** Percent-encoding as Signature Version 4 wants it: everything but A–Z a–z 0–9 - _ . ~ */
export function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** The headers that sign one request (Signature Version 4, header form). */
export function signRequest(request: {
  method: string;
  host: string;
  /** Already encoded, as sent. */
  path: string;
  query?: Record<string, string>;
  /** Further headers to sign, lower-case names. */
  headers?: Record<string, string>;
  payloadHash: string;
  at: Date;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Record<string, string> {
  const amzDate = request.at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...request.headers,
    host: request.host,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.entries(request.query ?? {})
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join("\n");
  const scope = `${day}/${request.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${request.secretAccessKey}`, day), request.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** The bytes of `stream` in pieces of exactly `size`, and the rest last. */
export async function* pieces(stream: Readable, size: number): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    held.push(chunk as Buffer);
    length += (chunk as Buffer).length;
    while (length >= size) {
      const all = Buffer.concat(held, length);
      yield all.subarray(0, size);
      held = [all.subarray(size)];
      length -= size;
    }
  }
  if (length > 0) yield Buffer.concat(held, length);
}

const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const tag = (xml: string, name: string) => {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return match ? unescapeXml(match[1]!) : undefined;
};

/** 32 MiB: few requests per backup, and little held in memory at once. */
const PART_BYTES = 32 * 1024 * 1024;
const RETRY_DELAYS_MS = [1000, 4000];

export class OffsiteBackups implements OffsiteUploader {
  readonly where: string;
  private readonly partBytes: number;
  private readonly send: typeof fetch;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly target: OffsiteTarget,
    readonly keep: number,
    opts: { partBytes?: number; fetch?: typeof fetch; retryDelaysMs?: number[] } = {},
  ) {
    this.where = `${target.origin}/${target.bucket}/${target.prefix}`;
    this.partBytes = opts.partBytes ?? PART_BYTES;
    this.send = opts.fetch ?? fetch;
    this.retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  async upload(dir: string, name: string, signal?: AbortSignal) {
    const key = `${this.target.prefix}${name}.zip`;
    const zip = zipArchive(await backupZipEntries(dir), backupFolderTime(name) ?? undefined);
    if (zip.length <= this.partBytes) {
      let body: Buffer = Buffer.alloc(0);
      for await (const piece of pieces(zip.open(), this.partBytes)) body = piece;
      await this.request("PUT", key, {}, body, signal, { "content-type": "application/zip" });
      return { key, bytes: zip.length };
    }
    const started = await this.request("POST", key, { uploads: "" }, Buffer.alloc(0), signal, {
      "content-type": "application/zip",
    });
    const uploadId = tag(started.text, "UploadId");
    if (!uploadId) throw new Error("Offsite copy: the bucket did not start a multipart upload.");
    try {
      const etags: string[] = [];
      for await (const part of pieces(zip.open(), this.partBytes)) {
        const sent = await this.request(
          "PUT",
          key,
          { partNumber: String(etags.length + 1), uploadId },
          part,
          signal,
        );
        const etag = sent.etag;
        if (!etag) throw new Error("Offsite copy: the bucket did not acknowledge a part.");
        etags.push(etag);
      }
      const body = Buffer.from(
        `<CompleteMultipartUpload>${etags
          .map(
            (etag, i) =>
              `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
          )
          .join("")}</CompleteMultipartUpload>`,
      );
      const done = await this.request("POST", key, { uploadId }, body, signal);
      // S3 can answer 200 and still fail the completion in the body.
      if (/<Error>/.test(done.text)) throw this.refused("POST", 200, done.text);
    } catch (error) {
      await this.request("DELETE", key, { uploadId }, Buffer.alloc(0)).catch(() => {});
      throw error;
    }
    return { key, bytes: zip.length };
  }

  async prune(signal?: AbortSignal) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix: `${this.target.prefix}backup-`,
      };
      if (token) query["continuation-token"] = token;
      const page = await this.request("GET", null, query, Buffer.alloc(0), signal);
      for (const match of page.text.matchAll(/<Key>([^<]*)<\/Key>/g))
        keys.push(unescapeXml(match[1]!));
      token =
        tag(page.text, "IsTruncated") === "true"
          ? tag(page.text, "NextContinuationToken")
          : undefined;
    } while (token);
    // Only names this schedule writes are counted or removed.
    const ours = keys
      .map((key) => {
        const name = key.slice(this.target.prefix.length);
        const at = name.endsWith(".zip") ? backupFolderTime(name.slice(0, -4)) : null;
        return { key, at };
      })
      .filter((entry): entry is { key: string; at: number } => entry.at !== null)
      .sort((a, b) => a.at - b.at);
    const doomed = ours.slice(0, Math.max(0, ours.length - this.keep)).map((entry) => entry.key);
    for (const key of doomed) await this.request("DELETE", key, {}, Buffer.alloc(0), signal);
    return doomed;
  }

  /** One signed request, tried again after a network failure or a 5xx or 429. */
  private async request(
    method: string,
    key: string | null,
    query: Record<string, string>,
    body: Buffer,
    signal?: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<{ text: string; etag: string | null }> {
    const path = `/${[this.target.bucket, ...(key === null ? [] : key.split("/"))]
      .map(encodeRfc3986)
      .join("/")}`;
    const search = Object.entries(query)
      .map(([name, value]) =>
        value === "" && name === "uploads"
          ? name
          : `${encodeRfc3986(name)}=${encodeRfc3986(value)}`,
      )
      .join("&");
    const url = `${this.target.origin}${path}${search ? `?${search}` : ""}`;
    const payloadHash = sha256Hex(body);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let failure: Error;
      try {
        const response = await this.send(url, {
          method,
          headers: signRequest({
            method,
            host: new URL(this.target.origin).host,
            path,
            query,
            headers,
            payloadHash,
            at: new Date(),
            region: this.target.region,
            accessKeyId: this.target.accessKeyId,
            secretAccessKey: this.target.secretAccessKey,
          }),
          // A Buffer is a Uint8Array; the DOM's fetch types want it said.
          body:
            method === "GET" || method === "DELETE" ? undefined : (body as Uint8Array<ArrayBuffer>),
          signal,
        });
        const text = await response.text();
        if (response.ok) return { text, etag: response.headers.get("etag") };
        failure = this.refused(method, response.status, text);
        if (response.status < 500 && response.status !== 429) throw failure;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "OffsiteRefused"))
          throw error;
        failure = error instanceof Error ? error : new Error(String(error));
      }
      const delay = this.retryDelaysMs[attempt];
      if (delay === undefined) throw failure;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** The bucket's own words for a refusal, which never hold the secret key. */
  private refused(method: string, status: number, text: string): Error {
    const code = tag(text, "Code");
    const message = tag(text, "Message");
    const error = new Error(
      `Offsite copy: ${method} was refused with ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
    );
    // A 4xx is not tried again; a 5xx or 429 is, by the caller.
    if (status < 500 && status !== 429) error.name = "OffsiteRefused";
    return error;
  }
}
