import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SettingsPanel, User } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { readZipEntries, readZipEntry } from "@ownbase/server/zip";
import { parseSyslog, syslogMessage } from "../src/auditStream.js";
import { zipName } from "../src/complianceExport.js";
import { enterprise } from "../src/enterprise.js";
import { GRACE_MS, LICENSE_PREFIX, type LicenseClaims } from "../src/license.js";

/**
 * Compliance (P12): legal hold, the export, and sending the administrative
 * record to a webhook or syslog, in the Enterprise edition with a license
 * that has `compliance`.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const licenseKeys = generateKeyPairSync("ed25519");
let clock = NOW;

function license(over: Partial<LicenseClaims> = {}): string {
  const claims: LicenseClaims = {
    id: "lic-acme",
    licensee: "Acme Ltd",
    plan: "enterprise",
    members: 200,
    features: ["compliance"],
    issuedAt: NOW - 30 * DAY,
    expiresAt: NOW + 300 * DAY,
    ...over,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(`${LICENSE_PREFIX}.${payload}`), licenseKeys.privateKey);
  return `${LICENSE_PREFIX}.${payload}.${signature.toString("base64url")}`;
}

let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
type Account = { token: string; user: User };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-compliance-"));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  clock = NOW;
  rmSync(directory, { recursive: true, force: true });
});

async function start(text: string | null = license(), over: { allowPrivateHooks?: boolean } = {}) {
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    retentionDays: 30,
    extensions: [enterprise({ license: text, trusted: [licenseKeys.publicKey], now: () => clock })],
    ...over,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function call(path: string, token?: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json().catch(() => null)) as any };
}

async function people() {
  const register = async (handle: string): Promise<Account> =>
    (
      await call("/api/auth/register", undefined, {
        handle,
        displayName: handle.charAt(0).toUpperCase() + handle.slice(1),
        password: "password123",
      })
    ).data;
  const owner = await register("owner");
  const maya = await register("maya");
  const sam = await register("sam");
  const general = server!.store.channels.byName("general")!.id;
  const legal = (await call("/api/channels", owner.token, { type: "public", name: "legal" })).data
    .channel.id as string;
  return { owner, maya, sam, general, legal };
}

async function post(who: Account, channelId: string, text: string, extra: object = {}) {
  const { data } = await call(`/api/channels/${channelId}/messages`, who.token, {
    text,
    ...extra,
  });
  return data.message as { id: string };
}

const remove = (who: Account, id: string) =>
  call(`/api/messages/${id}`, who.token, undefined, "DELETE");
const edit = (who: Account, id: string, text: string, expectedText: string) =>
  call(`/api/messages/${id}`, who.token, { text, expectedText }, "PATCH");
const panels = async (who: Account) =>
  (await call("/api/admin/extension-settings", who.token, undefined, "GET")).data
    .panels as SettingsPanel[];
const panel = async (who: Account, id: string) => (await panels(who)).find((p) => p.id === id);
const save = (who: Account, path: string, values: Record<string, string | boolean>) =>
  call(path, who.token, values, "PUT");
const audit = async (who: Account) =>
  (await call("/api/admin/audit", who.token, undefined, "GET")).data.entries as {
    action: string;
    actorId: string | null;
    details: Record<string, unknown>;
  }[];

/** Ages every message, through a second connection, as the server's retention tests do. */
function backdate(days: number) {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    db.exec(`UPDATE messages SET created_at = created_at - ${days * DAY}`);
  } finally {
    db.close();
  }
}

const exists = (id: string) =>
  server!.store.messages
    .recorded({
      from: 0,
      to: Date.now() + DAY,
      userIds: [],
      channelIds: server!.store.channels.all().map((c) => c.id),
      limit: 1000,
    })
    .some((m) => m.id === id);

describe("compliance in Workspace settings", () => {
  it("shows nothing without a license that has it", async () => {
    await start(license({ features: ["sso"] }));
    const { owner } = await people();
    expect((await panels(owner)).filter((p) => p.section === "compliance")).toEqual([]);
    expect((await save(owner, "/api/compliance/hold", { people: "maya" })).status).toBe(403);
  });

  it("offers legal hold, the export and sending the record, under Compliance, to the owner", async () => {
    await start();
    const { owner, sam } = await people();
    expect((await panels(owner)).map((p) => [p.id, p.section])).toEqual([
      ["legal-hold", "compliance"],
      ["compliance-export", "compliance"],
      ["audit-stream", "compliance"],
    ]);
    expect((await call("/api/admin/extension-settings", sam.token, undefined, "GET")).status).toBe(
      403,
    );
    expect((await save(sam, "/api/compliance/hold", { people: "maya" })).status).toBe(403);
  });
});

describe("legal hold", () => {
  it("keeps held people's and channels' messages from retention, and refuses their deletion", async () => {
    await start();
    const { owner, maya, sam, general, legal } = await people();
    const mayas = await post(maya, general, "held because maya wrote it");
    const inLegal = await post(sam, legal, "held because of where it is");
    const loose = await post(sam, general, "nothing holds this");
    const thread = await post(sam, general, "a thread maya answered");
    const reply = await post(maya, general, "a held reply", { threadRootId: thread.id });

    expect(await save(owner, "/api/compliance/hold", { people: "@nobody", channels: "" })).toEqual({
      status: 400,
      data: expect.objectContaining({ message: "Nobody here has the username nobody." }),
    });
    expect(await save(owner, "/api/compliance/hold", { people: "", channels: "#nowhere" })).toEqual(
      {
        status: 400,
        data: expect.objectContaining({ message: "There is no channel called nowhere." }),
      },
    );
    expect(
      (await save(owner, "/api/compliance/hold", { people: "@Maya", channels: "#legal" })).status,
    ).toBe(200);
    const shown = await panel(owner, "legal-hold");
    expect(shown?.fields.map((f) => f.value)).toEqual(["maya", "legal"]);
    expect(shown?.status).toMatch(/^Holding 1 person and 1 channel since /);
    expect((await audit(owner))[0]).toMatchObject({
      action: "extension.action",
      actorId: owner.user.id,
      details: { did: "changed the legal hold", people: 1, channels: 1 },
    });

    // Refused for the author, an admin, and the thread maya answered.
    for (const [who, id] of [
      [maya, mayas.id],
      [owner, mayas.id],
      [sam, inLegal.id],
      [maya, reply.id],
      [sam, thread.id],
    ] as const)
      expect(await remove(who, id)).toMatchObject({ status: 403, data: { error: "message_kept" } });

    backdate(60);
    expect(server!.applyRetention()).toBe(1);
    expect(exists(loose.id)).toBe(false);
    for (const id of [mayas.id, inLegal.id, thread.id, reply.id]) expect(exists(id)).toBe(true);
  });

  it("stays when the license ends: nothing can be added, and it can still be lifted", async () => {
    await start();
    const { owner, maya, sam, general } = await people();
    const mayas = await post(maya, general, "held");
    await save(owner, "/api/compliance/hold", { people: "maya", channels: "" });
    clock = NOW + 300 * DAY + GRACE_MS + DAY;

    expect((await panel(owner, "legal-hold"))?.problem).toBe(
      "Adding to the legal hold needs an Enterprise license with compliance. What is held stays held, and you can still lift it.",
    );
    expect(await save(owner, "/api/compliance/hold", { people: "maya, sam" })).toMatchObject({
      status: 403,
      data: { error: "license_required" },
    });
    expect((await remove(maya, mayas.id)).status).toBe(403);
    expect((await save(owner, "/api/compliance/hold", { people: "", channels: "" })).status).toBe(
      200,
    );
    expect((await audit(owner))[0]?.details.did).toBe("lifted the legal hold");
    expect((await remove(maya, mayas.id)).status).toBe(200);
    // Nothing held and no license: the panel goes.
    expect(await panel(owner, "legal-hold")).toBeUndefined();
    expect((await save(owner, "/api/compliance/hold", { people: "sam" })).status).toBe(403);
  });
});

describe("the export", () => {
  async function download(owner: Account) {
    const link = await call("/api/compliance/export/link", owner.token);
    expect(link.status).toBe(200);
    const url = `${base}${link.data.download as string}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
    const path = join(directory, "export.zip");
    writeFileSync(path, bytes);
    const entries = await readZipEntries(path);
    const read = async (name: string) =>
      (
        await readZipEntry(
          path,
          entries.find((e) => e.name === name)!,
        )
      ).toString("utf8");
    const jsonl = async (name: string) =>
      (await read(name))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    return { url, entries, read, jsonl };
  }

  it("has a range's messages, edits and deletions for people and channels, with their files", async () => {
    await start();
    const { owner, maya, sam, general, legal } = await people();
    const dm = (await call("/api/channels", sam.token, { type: "dm", memberIds: [maya.user.id] }))
      .data.channel.id as string;
    const form = new FormData();
    form.append("file", new Blob(["the contract, signed"]), "contract.txt");
    const uploaded = await fetch(`${base}/api/channels/${general}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${maya.token}` },
      body: form,
    });
    const fileId = ((await uploaded.json()) as { file: { id: string } }).file.id;
    await save(owner, "/api/compliance/hold", { people: "maya" });
    const withFile = await post(maya, general, "the signed contract", { fileIds: [fileId] });
    const edited = await post(maya, general, "the first words");
    await edit(maya, edited.id, "the second words", "the first words");
    const takenBack = await post(sam, legal, "taken back");
    await remove(sam, takenBack.id);
    const direct = await post(sam, dm, "sam to maya, in private");
    await post(sam, general, "neither maya's nor in legal");

    const choose = (values: Record<string, string>) =>
      save(owner, "/api/compliance/export/choice", values);
    expect(
      await choose({ from: "2026-02-30", to: "2026-03-01", people: "maya", channels: "" }),
    ).toMatchObject({
      status: 400,
      data: { message: expect.stringContaining("such as 2026-01-31") },
    });
    expect(
      await choose({ from: "2026-03-02", to: "2026-03-01", people: "maya", channels: "" }),
    ).toMatchObject({ status: 400, data: { message: "The last day comes before the first." } });
    expect(
      await choose({ from: "2026-03-01", to: "2026-03-02", people: "", channels: "" }),
    ).toMatchObject({ status: 400, data: { message: "Choose people, channels or both." } });
    // Nothing chosen yet, so nothing to download.
    expect((await call("/api/compliance/export/link", owner.token)).status).toBe(409);
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (await choose({ from: today, to: today, people: "maya", channels: "#legal" })).status,
    ).toBe(200);
    const shown = await panel(owner, "compliance-export");
    expect(shown?.actions?.map((a) => a.label)).toEqual(["Download the export"]);

    const { url, entries, read, jsonl } = await download(owner);
    expect(entries.map((e) => e.name)).toEqual([
      "manifest.json",
      "messages.jsonl",
      "conversations.jsonl",
      "people.jsonl",
      zipName(fileId, "contract.txt"),
    ]);
    const messages = await jsonl("messages.jsonl");
    expect(messages.map((m) => m.id)).toEqual([withFile.id, edited.id, takenBack.id, direct.id]);
    expect(messages[0]).toMatchObject({
      authorId: maya.user.id,
      conversationId: general,
      text: "the signed contract",
      files: [{ id: fileId, name: "contract.txt", path: zipName(fileId, "contract.txt") }],
    });
    // An edit while held keeps the words it replaced.
    expect(messages[1]).toMatchObject({
      text: "the second words",
      editedAt: expect.any(String),
      earlierVersions: [{ text: "the first words" }],
    });
    // A deletion has who, where and when, and nothing of what it said.
    expect(messages[2]).toMatchObject({
      authorId: sam.user.id,
      conversationId: legal,
      text: "",
      files: [],
      deletedAt: expect.any(String),
    });
    // Maya's direct conversation, whoever wrote in it.
    expect(messages[3]).toMatchObject({ conversationId: dm, text: "sam to maya, in private" });
    expect(await read(zipName(fileId, "contract.txt"))).toBe("the contract, signed");
    const manifest = JSON.parse(await read("manifest.json"));
    expect(manifest).toMatchObject({
      format: 1,
      madeBy: { handle: "owner" },
      people: [maya.user.id],
      counts: { messages: 4, deleted: 1, edited: 1, files: 1 },
    });
    expect(manifest.deletions).toContain("Its words and files were erased");
    expect((await jsonl("conversations.jsonl")).map((c) => c.name)).toEqual([
      "general",
      "legal",
      expect.stringMatching(/^(maya, sam|sam, maya)$/),
    ]);
    expect((await jsonl("people.jsonl")).map((p) => p.handle).sort()).toEqual(["maya", "sam"]);
    expect((await audit(owner))[0]).toMatchObject({
      actorId: owner.user.id,
      details: { did: "downloaded a compliance export", messages: 4, people: 1, channels: 1 },
    });

    // The link opens once, and only for the owner's session.
    expect((await fetch(url)).status).toBe(404);
    expect((await call("/api/compliance/export/link", sam.token)).status).toBe(403);

    // No new exports once the license has ended.
    clock = NOW + 300 * DAY + GRACE_MS + DAY;
    expect(await panel(owner, "compliance-export")).toBeUndefined();
    expect((await call("/api/compliance/export/link", owner.token)).status).toBe(403);
  });
});

describe("sending the administrative record", () => {
  let hook: Server;
  let received: { entries: { id: string; action: string; details: Record<string, unknown> }[] }[];
  let answer: number;
  const signingWords = ["signing", "words", "for", "the", "test", "hook"].join("-");

  beforeEach(async () => {
    received = [];
    answer = 200;
    hook = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const ts = req.headers["x-ownbase-request-timestamp"] as string;
        const expected = `v0=${createHmac("sha256", signingWords).update(`v0:${ts}:${body}`).digest("hex")}`;
        if (req.headers["x-ownbase-signature"] !== expected) {
          res.statusCode = 401;
          res.end();
          return;
        }
        res.statusCode = answer;
        if (answer === 200) received.push(JSON.parse(body));
        res.end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
  });

  afterEach(() => new Promise<void>((resolve) => hook.close(() => resolve())));

  const hookUrl = () => `http://127.0.0.1:${(hook.address() as { port: number }).port}/ownbase`;
  const sentIds = () => received.flatMap((r) => r.entries.map((e) => e.id));

  it("signs each entry to a webhook, in order, and catches up after a failure", async () => {
    await start(license(), { allowPrivateHooks: true });
    const { owner, sam } = await people();
    expect(
      await save(owner, "/api/compliance/stream", { webhook: hookUrl(), secret: "short" }),
    ).toMatchObject({ status: 400, data: { message: expect.stringContaining("16 characters") } });
    expect(
      (await save(owner, "/api/compliance/stream", { webhook: hookUrl(), secret: signingWords }))
        .status,
    ).toBe(200);
    // The whole record first, the entry saying where it goes included.
    await expect
      .poll(() => received.at(-1)?.entries.at(-1)?.details.did)
      .toBe("set the administrative record to be sent to a webhook");
    expect((await panel(owner, "audit-stream"))?.status).toMatch(/^Sent up to /);
    expect((await panel(owner, "audit-stream"))?.fields.find((f) => f.key === "secret")).toEqual(
      expect.objectContaining({ value: "", isSet: true }),
    );

    answer = 500;
    await call(`/api/admin/users/${sam.user.id}`, owner.token, { deactivated: true }, "PATCH");
    await expect
      .poll(async () => (await panel(owner, "audit-stream"))?.status)
      .toMatch(/failed\. The webhook answered 500\. It is tried again every minute/);

    answer = 200;
    await call(`/api/admin/users/${sam.user.id}`, owner.token, { deactivated: false }, "PATCH");
    await expect.poll(() => received.at(-1)?.entries.at(-1)?.action).toBe("user.reactivated");
    const all = server!.store.audit.after(null, 1000).map((e) => e.id);
    // Every entry, once each and in order: none was skipped by the failure.
    expect(sentIds()).toEqual(all);
    expect((await panel(owner, "audit-stream"))?.status).toMatch(/^Sent up to /);
  });

  it("goes through the outbound guard, which refuses a private address unless allowed", async () => {
    await start();
    const { owner } = await people();
    await save(owner, "/api/compliance/stream", { webhook: hookUrl(), secret: signingWords });
    await expect.poll(async () => (await panel(owner, "audit-stream"))?.status).toMatch(/failed\./);
    expect(received).toEqual([]);
  });

  it("sends each entry to syslog over UDP and TCP, as RFC 5424 messages", async () => {
    const udp: UdpSocket = createSocket("udp4");
    const udpLines: string[] = [];
    udp.on("message", (msg) => udpLines.push(msg.toString("utf8")));
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    let tcpBytes = "";
    const tcp: TcpServer = createTcpServer((socket) =>
      socket.on("data", (chunk) => (tcpBytes += chunk.toString("utf8"))),
    );
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    try {
      await start();
      const { owner } = await people();
      expect(
        await save(owner, "/api/compliance/stream", { syslog: "http://logs.acme.com" }),
      ).toMatchObject({ status: 400 });
      const udpPort = udp.address().port;
      await save(owner, "/api/compliance/stream", { syslog: `udp://127.0.0.1:${udpPort}` });
      await expect
        .poll(() => udpLines.at(-1))
        .toMatch(
          /^<110>1 \d{4}-\d\d-\d\dT[\d:.]+Z \S+ ownbase - extension\.action - \{.*"did":"set the administrative record to be sent to syslog"/,
        );

      const tcpPort = (tcp.address() as { port: number }).port;
      await save(owner, "/api/compliance/stream", { syslog: `tcp://127.0.0.1:${tcpPort}` });
      // Octet counted: the length, a space, then the message.
      await expect.poll(() => tcpBytes).toMatch(/^\d+ <110>1 /);
      const frames: string[] = [];
      let rest = Buffer.from(tcpBytes);
      while (rest.length > 0) {
        const space = rest.indexOf(32);
        const length = Number(rest.subarray(0, space).toString());
        frames.push(rest.subarray(space + 1, space + 1 + length).toString("utf8"));
        rest = rest.subarray(space + 1 + length);
      }
      // A new destination gets the whole record.
      expect(frames.length).toBe(server!.store.audit.after(null, 1000).length);
    } finally {
      udp.close();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
  });

  it("stops sending when the license ends, and can be turned off then", async () => {
    await start(license(), { allowPrivateHooks: true });
    const { owner, sam } = await people();
    await save(owner, "/api/compliance/stream", { webhook: hookUrl(), secret: signingWords });
    await expect.poll(() => received.length).toBe(1);
    clock = NOW + 300 * DAY + GRACE_MS + DAY;
    await call(`/api/admin/users/${sam.user.id}`, owner.token, { deactivated: true }, "PATCH");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received.length).toBe(1);
    expect((await panel(owner, "audit-stream"))?.problem).toContain("Nothing more is sent");
    expect((await save(owner, "/api/compliance/stream", { webhook: "", syslog: "" })).status).toBe(
      200,
    );
    expect(await panel(owner, "audit-stream")).toBeUndefined();
  });
});

describe("a syslog address and message", () => {
  it("reads udp, tcp and tls addresses, and nothing else", () => {
    expect(parseSyslog("udp://logs.acme.com:514")).toEqual({
      protocol: "udp",
      host: "logs.acme.com",
      port: 514,
    });
    expect(parseSyslog("tls://[2001:db8::1]:6514")).toEqual({
      protocol: "tls",
      host: "2001:db8::1",
      port: 6514,
    });
    for (const bad of ["logs.acme.com:514", "http://logs:514", "udp://logs", "udp://logs:70000"])
      expect(parseSyslog(bad), bad).toBeNull();
  });

  it("keeps a header without spaces where RFC 5424 has none", () => {
    const line = syslogMessage(
      {
        id: "01ENTRY",
        at: 0,
        time: "1970-01-01T00:00:00.000Z",
        actorId: null,
        actor: null,
        action: "user.deactivated",
        targetType: "user",
        targetId: "U1",
        details: { by: "SCIM provisioning" },
      },
      "chat.acme.com",
    );
    expect(line).toBe(
      '<110>1 1970-01-01T00:00:00.000Z chat.acme.com ownbase - user.deactivated - {"id":"01ENTRY","at":0,"time":"1970-01-01T00:00:00.000Z","actorId":null,"actor":null,"action":"user.deactivated","targetType":"user","targetId":"U1","details":{"by":"SCIM provisioning"}}',
    );
  });
});
