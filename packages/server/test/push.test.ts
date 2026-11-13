import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@ownbase/protocol";
import { PushSender, PUSH_LIMITS, type PostPush } from "../src/push/sender.js";
import type { PushSubscription } from "../src/push/store.js";
import { b64url, makeVapidKeys } from "../src/push/webPush.js";
import { createWorkspaceServer, type ServerOptions, type WorkspaceServer } from "../src/server.js";

/**
 * Pushes to closed browsers (G09): subscriptions kept per session and gone
 * with it, the notify rule deciding who is pushed to, and the push service's
 * answers. A local HTTP server stands in for the push service.
 */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
let channelId: string;
const sockets: WebSocket[] = [];

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
let sink: Server;
let sinkUrl: string;
let received: Received[];
/** What the sink answers, by path; 201 when not set. */
let answers: Map<string, number[]>;

beforeEach(async () => {
  received = [];
  answers = new Map();
  sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      const queued = answers.get(req.url ?? "");
      res.statusCode = queued?.shift() ?? 201;
      res.end();
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const address = sink.address();
  sinkUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-push-"));
});

afterEach(async () => {
  await stop();
  await new Promise((resolve) => sink.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(options: Partial<ServerOptions> = {}) {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    allowPrivateHooks: true,
    pushLimits: { retryBaseMs: 10 },
    ...options,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function stop() {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
}

async function request(path: string, body?: unknown, method = "POST", auth = owner.token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function register(handle: string, displayName: string) {
  const made = await request(
    "/api/auth/register",
    { handle, displayName, password: "password123" },
    "POST",
    "",
  );
  return { token: made.body.token as string, id: made.body.user.id as string };
}

async function signIn(handle: string) {
  const made = await request("/api/auth/login", { handle, password: "password123" }, "POST", "");
  return made.body.token as string;
}

async function startWithPeople(options: Partial<ServerOptions> = {}) {
  await start(options);
  owner = await register("owner", "Owner");
  peer = await register("peer", "Peer");
  channelId = server!.store.channels.byName("general")!.id;
}

async function connect(auth: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  let ready = false;
  ws.on("message", (data) => {
    if ((JSON.parse(String(data)) as { type: string }).type === "ready") ready = true;
  });
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token: auth,
        lastSeq: null,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await expect.poll(() => ready).toBe(true);
  return ws;
}

/** A browser: its key pair and secret, and the subscription it would send up. */
function browser(path: string, preview: "full" | "sender" | "none" = "full") {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const secret = randomBytes(16);
  return {
    receiver,
    secret,
    path,
    body: {
      endpoint: `${sinkUrl}${path}`,
      keys: { p256dh: b64url(receiver.getPublicKey()), auth: b64url(secret) },
      preview,
    },
  };
}
type Browser = ReturnType<typeof browser>;

const subscribe = (device: Browser, auth = owner.token) =>
  request("/api/push/subscription", device.body, "PUT", auth);

/** What the browser reads out of a push (RFC 8291 decryption). */
function open(body: Buffer, device: Browser): any {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPoint = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    device.receiver.getPublicKey(),
    senderPoint,
  ]);
  const ecdh = device.receiver.computeSecret(senderPoint);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh, device.secret, info, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

let nonce = 0;
const post = async (text: string, auth = peer.token, channel = channelId) => {
  const sent = await request(
    `/api/channels/${channel}/messages`,
    { text, nonce: `n-${++nonce}` },
    "POST",
    auth,
  );
  expect(sent.status).toBe(201);
  return sent.body.message as { id: string };
};

const pushesTo = (device: Browser) => received.filter((r) => r.path === device.path);

describe("a push subscription", () => {
  it("is kept for the session, replaced when sent again, and removed on request", async () => {
    await startWithPeople();
    const first = browser("/a");
    expect((await subscribe(first)).status).toBe(200);
    expect(server!.store.push.forUser(owner.id).map((s) => s.endpoint)).toEqual([
      first.body.endpoint,
    ]);
    // The same session subscribing again (a new endpoint) keeps only the newer.
    const second = browser("/b", "none");
    await subscribe(second);
    expect(server!.store.push.forUser(owner.id)).toMatchObject([
      { endpoint: second.body.endpoint, preview: "none" },
    ]);
    expect((await request("/api/push/subscription", undefined, "DELETE")).status).toBe(200);
    expect(server!.store.push.forUser(owner.id)).toEqual([]);
  });

  it("goes when the session signs out, is ended elsewhere, or the password changes", async () => {
    await startWithPeople();
    await subscribe(browser("/a"));
    await request("/api/auth/logout", {}, "POST");
    expect(server!.store.push.forUser(owner.id)).toEqual([]);

    const laptop = await signIn("owner");
    const phone = await signIn("owner");
    await subscribe(browser("/laptop"), laptop);
    await subscribe(browser("/phone"), phone);
    expect(server!.store.push.forUser(owner.id)).toHaveLength(2);
    // Ended from the laptop's list of sessions.
    const sessions = (await request("/api/auth/sessions", undefined, "GET", laptop)).body
      .sessions as { id: string; current: boolean }[];
    const other = sessions.find((s) => !s.current)!;
    await request(`/api/auth/sessions/${other.id}`, undefined, "DELETE", laptop);
    expect(server!.store.push.forUser(owner.id).map((s) => s.endpoint)).toEqual([
      `${sinkUrl}/laptop`,
    ]);

    // A new password ends every other session, and so their pushes.
    const tablet = await signIn("owner");
    await subscribe(browser("/tablet"), tablet);
    const changed = await request(
      "/api/auth/password",
      { currentPassword: "password123", newPassword: "password456" },
      "POST",
      laptop,
    );
    expect(changed.status).toBe(200);
    expect(server!.store.push.forUser(owner.id).map((s) => s.endpoint)).toEqual([
      `${sinkUrl}/laptop`,
    ]);
  });

  it("refuses a push address on a private network, or not on HTTPS", async () => {
    await startWithPeople({ allowPrivateHooks: false });
    const device = browser("/a");
    for (const endpoint of [
      device.body.endpoint,
      "https://127.0.0.1/push",
      "https://10.1.2.3/push",
      "https://[::1]/push",
      "https://localhost/push",
      "http://push.example.com/push",
      "not an address",
    ]) {
      const refused = await subscribe({ ...device, body: { ...device.body, endpoint } });
      expect(refused.status, endpoint).toBe(400);
      expect(refused.body.error, endpoint).toBe("push_endpoint_refused");
    }
    expect(server!.store.push.count()).toBe(0);
  });

  it("refuses keys a browser could not have made", async () => {
    await startWithPeople();
    const device = browser("/a");
    const refused = await subscribe({
      ...device,
      body: { ...device.body, keys: { ...device.body.keys, p256dh: b64url(Buffer.alloc(65, 4)) } },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("push_keys_invalid");
  });

  it("gives the same server key every time, kept with the workspace", async () => {
    await startWithPeople();
    const first = (await request("/api/push/key", undefined, "GET")).body.publicKey;
    expect(Buffer.from(first, "base64url")).toHaveLength(65);
    await stop();
    await start();
    expect((await request("/api/push/key", undefined, "GET")).body.publicKey).toBe(first);
  });
});

describe("a new message", () => {
  it("pushes to whoever the rule notifies and has no connection open", async () => {
    await startWithPeople();
    const third = await register("third", "Third");
    const fourth = await register("fourth", "Fourth");
    const ownersBrowser = browser("/owner");
    const peersBrowser = browser("/peer");
    const thirdsBrowser = browser("/third");
    const fourthsBrowser = browser("/fourth");
    await subscribe(ownersBrowser);
    await subscribe(peersBrowser, peer.token);
    await subscribe(thirdsBrowser, third.token);
    await subscribe(fourthsBrowser, fourth.token);
    // Third has the app open, so the app notifies them; Fourth muted #general.
    await connect(third.token);
    await request(`/api/channels/${channelId}/prefs`, { muted: true }, "PATCH", fourth.token);

    const message = await post(`Lunch at one, <@${owner.id}> <@${third.id}> <@${fourth.id}>?`);
    await server!.flushPushes();

    expect(pushesTo(ownersBrowser)).toHaveLength(1);
    // Not the sender, not someone online, not someone who muted it.
    expect(pushesTo(peersBrowser)).toEqual([]);
    expect(pushesTo(thirdsBrowser)).toEqual([]);
    expect(pushesTo(fourthsBrowser)).toEqual([]);

    const [push] = pushesTo(ownersBrowser);
    expect(push!.headers["content-encoding"]).toBe("aes128gcm");
    expect(push!.headers.ttl).toBe("86400");
    expect(String(push!.headers.authorization)).toMatch(/^vapid t=.+, k=.+$/);
    expect(open(push!.body, ownersBrowser)).toEqual({
      title: "Peer in #general",
      body: "Lunch at one, @Owner @Third @Fourth?",
      tag: `c:${channelId}`,
      channelId,
      messageId: message.id,
    });
  });

  it("says only that there is a message where the device asked for private notifications", async () => {
    await startWithPeople();
    const quiet = browser("/owner", "none");
    await subscribe(quiet);
    await post(`<@${owner.id}> the launch code is 1234`);
    await server!.flushPushes();
    expect(open(pushesTo(quiet)[0]!.body, quiet)).toMatchObject({
      title: "New message",
      body: "Open OwnBase to read it.",
    });
  });

  it("pushes nothing for a message the account's level holds back", async () => {
    await startWithPeople();
    const device = browser("/owner");
    await subscribe(device);
    // #general follows the account's default, mentions only.
    await post("Nobody in particular");
    await server!.flushPushes();
    expect(pushesTo(device)).toEqual([]);
  });

  it("pushes for a reminder that comes due while the app is closed", async () => {
    await startWithPeople();
    const device = browser("/owner");
    await subscribe(device);
    const message = await post("Renew the domain");
    await request(`/api/messages/${message.id}/reminder`, { at: Date.now() + 300 }, "PUT");
    await expect.poll(() => pushesTo(device).length, { timeout: 5_000 }).toBe(1);
    expect(open(pushesTo(device)[0]!.body, device)).toMatchObject({
      title: "Reminder: Peer in #general",
      body: "Renew the domain",
      tag: `r:${message.id}`,
    });
    expect(pushesTo(device)[0]!.headers.urgency).toBe("high");
  });

  it("forgets a browser the push service says is gone", async () => {
    await startWithPeople();
    const device = browser("/owner");
    await subscribe(device);
    answers.set("/owner", [410]);
    await post(`<@${owner.id}> hello`);
    await server!.flushPushes();
    expect(pushesTo(device)).toHaveLength(1);
    expect(server!.store.push.forUser(owner.id)).toEqual([]);
  });

  it("tries again after a 503, then delivers", async () => {
    await startWithPeople();
    const device = browser("/owner");
    await subscribe(device);
    answers.set("/owner", [503, 429]);
    await post(`<@${owner.id}> hello`);
    await server!.flushPushes();
    expect(pushesTo(device)).toHaveLength(3);
    expect(server!.store.push.forUser(owner.id)).toHaveLength(1);
  });

  it("pushes once per conversation in a few seconds, and to a capped number of people", async () => {
    await startWithPeople({ pushLimits: { recipientsPerMessage: 2, retryBaseMs: 10 } });
    await request(`/api/channels/${channelId}/prefs`, { notifyLevel: "all" }, "PATCH");
    const others = [];
    for (const handle of ["a1", "a2", "a3"]) {
      const person = await register(handle, handle);
      await request(
        `/api/channels/${channelId}/prefs`,
        { notifyLevel: "all" },
        "PATCH",
        person.token,
      );
      const device = browser(`/${handle}`);
      await subscribe(device, person.token);
      others.push(device);
    }
    const ownersBrowser = browser("/owner");
    await subscribe(ownersBrowser);

    await post("One");
    await post("Two");
    await server!.flushPushes();
    // Four people would be notified; two are pushed to, once each.
    expect(received).toHaveLength(2);
    expect(new Set(received.map((r) => r.path)).size).toBe(2);
    expect(
      open(
        received[0]!.body,
        [...others, ownersBrowser].find((d) => d.path === received[0]!.path)!,
      ).body,
    ).toBe("One");
  });

  it("does not ring anyone from an isolated copy of a workspace", async () => {
    await startWithPeople();
    await subscribe(browser("/owner"));
    await stop();
    await start({ isolated: true });
    await post(`<@${owner.id}> hello`);
    await server!.flushPushes();
    expect(received).toEqual([]);
  });
});

describe("the push sender", () => {
  const subscriptionFor = (n: number): PushSubscription => {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    return {
      endpoint: `https://push.example.com/${n}`,
      userId: `u${n}`,
      p256dh: b64url(receiver.getPublicKey()),
      auth: b64url(randomBytes(16)),
      preview: "full",
    };
  };
  const quietLog = { warn: () => {} } as never;

  it("drops the oldest pushes when its queue is full", async () => {
    const posted: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const post: PostPush = async (url) => {
      posted.push(url);
      await held;
      return { status: 201, headers: {} };
    };
    const keys = makeVapidKeys();
    const sender = new PushSender({
      post,
      keys: () => keys,
      subject: "https://chat.example.com",
      limits: { ...PUSH_LIMITS, concurrency: 1, queue: 2 },
      log: quietLog,
      gone: () => {},
    });
    for (let n = 1; n <= 5; n++) sender.send(subscriptionFor(n), "{}");
    // 1 is being sent; of 2 to 5 waiting, only the newest two stay.
    expect(sender.counts.dropped).toBe(2);
    release();
    await sender.settled();
    expect(posted.map((url) => url.split("/").pop())).toEqual(["1", "4", "5"]);
    expect(sender.counts).toEqual({ sent: 3, failed: 0, dropped: 2 });
  });

  it("gives up after its retries", async () => {
    let tries = 0;
    const keys = makeVapidKeys();
    const sender = new PushSender({
      post: async () => {
        tries++;
        return { status: 500, headers: {} };
      },
      keys: () => keys,
      subject: "https://chat.example.com",
      limits: { ...PUSH_LIMITS, retries: 2, retryBaseMs: 1 },
      log: quietLog,
      gone: () => {},
    });
    sender.send(subscriptionFor(1), "{}");
    await sender.settled();
    expect(tries).toBe(3);
    expect(sender.counts).toEqual({ sent: 0, failed: 1, dropped: 0 });
  });
});
