import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import {
  cloudflareIceServers,
  createRelaySource,
  relayFromEnvironment,
  sharedSecretCredential,
  withRelay,
  type CallRelay,
  type ServerRelay,
  type SharedSecretRelay,
} from "../src/relay.js";

const cloudflare = { kind: "cloudflare", keyId: "key-1", apiToken: "token-1" } as const;

/** What Cloudflare's credential endpoint answers, as its documentation shows. */
const answer = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const offered = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "short-lived-user",
      credential: "short-lived-password",
    },
  ],
};

describe("asking Cloudflare for a relay", () => {
  it("asks with the key's token for a day's password, and leaves out port 53", async () => {
    const fetch = vi.fn(async () => answer(offered));
    const servers = await cloudflareIceServers(cloudflare, { fetch });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key-1/credentials/generate-ice-servers",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 86400 });
    expect(servers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "short-lived-user",
        credential: "short-lived-password",
      },
    ]);
  });

  it("says what Cloudflare refused, in words a host can act on", async () => {
    const refusing = (status: number) => vi.fn(async () => answer({}, status));
    await expect(cloudflareIceServers(cloudflare, { fetch: refusing(401) })).rejects.toThrow(
      "Cloudflare refused the API token for this TURN key.",
    );
    await expect(cloudflareIceServers(cloudflare, { fetch: refusing(404) })).rejects.toThrow(
      "Cloudflare has no TURN key with that ID.",
    );
    await expect(cloudflareIceServers(cloudflare, { fetch: refusing(500) })).rejects.toThrow(
      "Cloudflare's TURN service answered 500.",
    );
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(cloudflareIceServers(cloudflare, { fetch: offline })).rejects.toThrow(
      "Could not reach Cloudflare's TURN service.",
    );
    const stunOnly = vi.fn(async () => answer({ iceServers: [offered.iceServers[0]] }));
    await expect(cloudflareIceServers(cloudflare, { fetch: stunOnly })).rejects.toThrow(
      "Cloudflare's TURN service offered no relay.",
    );
  });

  it("never puts the API token in what it says went wrong", async () => {
    const refusing = vi.fn(async () => answer({}, 403));
    const failure = await cloudflareIceServers(cloudflare, { fetch: refusing }).catch(
      (err: Error) => err,
    );
    expect(String(failure)).not.toContain("token-1");
  });
});

describe("the relay calls are given", () => {
  it("reuses a password for an hour, and asks once for everyone joining at the same time", async () => {
    let now = 0;
    const fetch = vi.fn(async () => answer(offered));
    const source = createRelaySource(cloudflare, { fetch, now: () => now });
    const [first, second] = await Promise.all([source.servers("user-1"), source.servers("user-1")]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 59 * 60 * 1000;
    await source.servers("user-1");
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 61 * 60 * 1000;
    await source.servers("user-1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives no relay for a while after a refusal, and says why until one works", async () => {
    let now = 0;
    let refuse = true;
    const fetch = vi.fn(async () => (refuse ? answer({}, 401) : answer(offered)));
    const onError = vi.fn();
    const source = createRelaySource(cloudflare, { fetch, now: () => now, onError });
    expect(await source.servers("user-1")).toEqual([]);
    expect(source.error()).toBe("Cloudflare refused the API token for this TURN key.");
    expect(onError).toHaveBeenCalledTimes(1);
    now = 10_000;
    expect(await source.servers("user-1")).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    refuse = false;
    now = 31_000;
    expect(await source.servers("user-1")).toHaveLength(2);
    expect(source.error()).toBeNull();
  });

  it("gives another relay as it was set, and nothing without one", async () => {
    const custom: CallRelay = {
      kind: "custom",
      urls: ["turn:turn.example.org:3478"],
      username: "workspace",
      credential: "secret",
    };
    expect(await createRelaySource(custom).servers("user-1")).toEqual([
      { urls: ["turn:turn.example.org:3478"], username: "workspace", credential: "secret" },
    ]);
    expect(await createRelaySource(null).servers("user-1")).toEqual([]);
  });

  it("leaves out an address the workspace already gives", () => {
    expect(
      withRelay([{ urls: "stun:stun.cloudflare.com:3478" }], offered.iceServers.slice(0, 1)),
    ).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: ["stun:stun.cloudflare.com:53"] },
    ]);
  });

  it("reads a Cloudflare relay from the environment only when both halves are there", () => {
    const env = (values: Record<string, string>) => (name: string) => values[name];
    expect(relayFromEnvironment(env({}))).toBeNull();
    expect(
      relayFromEnvironment(
        env({ CLOUDFLARE_TURN_KEY_ID: "key-1", CLOUDFLARE_TURN_API_TOKEN: " token-1 " }),
      ),
    ).toEqual(cloudflare);
    expect(() => relayFromEnvironment(env({ CLOUDFLARE_TURN_KEY_ID: "key-1" }))).toThrow(
      /must both be set/,
    );
  });
});

describe("a relay that shares a secret with the server", () => {
  const shared: SharedSecretRelay = {
    kind: "shared-secret",
    urls: ["turn:turn.example.org:3478", "turns:turn.example.org:5349"],
    secret: "the-shared-secret-16",
  };
  const env = (values: Record<string, string>) => (name: string) => values[name];

  it("signs a member's password as coturn checks it, lasting a day", () => {
    // Made with `printf '%s' '1700086400:user-1' | openssl dgst -sha1 -hmac
    // 'the-shared-secret-16' -binary | base64`, not by the code under test.
    expect(sharedSecretCredential(shared, "user-1", 1_700_000_000_000)).toEqual({
      urls: shared.urls,
      username: "1700086400:user-1",
      credential: "grG425QDUFgs4fkCR7JJA1F1zjI=",
    });
    expect(sharedSecretCredential(shared, "user-2", 1_700_000_000_999).credential).toBe(
      "cJ/XtV9ltameAfNdAXsDDnxqiBw=",
    );
  });

  it("gives each member a password of their own, made when they ask", async () => {
    let now = 1_700_000_000_000;
    const source = createRelaySource(shared, { now: () => now });
    const ada = (await source.servers("ada"))[0]!;
    const bo = (await source.servers("bo"))[0]!;
    expect(ada.username).toBe("1700086400:ada");
    expect(bo.username).toBe("1700086400:bo");
    expect(ada.credential).not.toBe(bo.credential);
    now += 60 * 60 * 1000;
    expect((await source.servers("ada"))[0]!.username).toBe("1700090000:ada");
    expect(source.error()).toBeNull();
  });

  it("reads it from the environment, its addresses and secret together", () => {
    expect(
      relayFromEnvironment(
        env({
          TURN_URLS: " turn:turn.example.org:3478, turns:turn.example.org:5349 ",
          TURN_SECRET: " the-shared-secret-16 ",
        }),
      ),
    ).toEqual(shared);
    // Spaces or line breaks separate them too, as a multi-line setting would.
    expect(
      relayFromEnvironment(
        env({
          TURN_URLS: "turn:turn.example.org:3478\nturns:turn.example.org:5349",
          TURN_SECRET: "the-shared-secret-16",
        }),
      ),
    ).toEqual(shared);
  });

  it("refuses half of one, a wrong address, a short secret, or two relays", () => {
    const refused = (values: Record<string, string>) => {
      try {
        relayFromEnvironment(env(values));
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("not refused");
    };
    expect(refused({ TURN_URLS: "turn:turn.example.org:3478" })).toMatch(
      /OWNBASE_TURN_URLS needs OWNBASE_TURN_SECRET/,
    );
    expect(refused({ TURN_SECRET: "the-shared-secret-16" })).toMatch(
      /OWNBASE_TURN_SECRET needs OWNBASE_TURN_URLS/,
    );
    expect(
      refused({ TURN_URLS: "https://turn.example.org", TURN_SECRET: "the-shared-secret-16" }),
    ).toMatch(/starting turn: or turns:/);
    expect(
      refused({
        TURN_URLS: Array(9).fill("turn:turn.example.org:3478").join(","),
        TURN_SECRET: "the-shared-secret-16",
      }),
    ).toMatch(/up to eight/);
    const short = refused({ TURN_URLS: "turn:turn.example.org:3478", TURN_SECRET: "too-short-1" });
    expect(short).toMatch(/at least 16 characters/);
    expect(short).not.toContain("too-short-1");
    expect(
      refused({ TURN_URLS: "turn:turn.example.org:3478", TURN_SECRET: "has a space in it ok" }),
    ).toMatch(/no spaces/);
    expect(
      refused({
        TURN_URLS: "turn:turn.example.org:3478",
        TURN_SECRET: "the-shared-secret-16",
        CLOUDFLARE_TURN_KEY_ID: "key-1",
      }),
    ).toMatch(/Set one call relay/);
  });

  it("stops the server at the door with the reason, not a stack trace", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ownbase-relay-cli-"));
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../src/main.ts", import.meta.url)),
          ...["--data", dataDir, "--port", "0", "--host", "127.0.0.1", "--no-mdns"],
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            ...process.env,
            OWNBASE_TURN_URLS: "turn:turn.example.org:3478",
            OWNBASE_TURN_SECRET: "too-short-1",
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (output += String(chunk)));
      expect(await new Promise((resolve) => child.once("exit", resolve))).toBe(1);
      expect(output).toContain("OWNBASE_TURN_SECRET must be at least 16 characters");
      expect(output).not.toMatch(/\n\s+at /);
      expect(output).not.toContain("too-short-1");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a workspace given a relay while it runs", () => {
  let server: WorkspaceServer | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("gives calls started afterwards the relay, and keeps it when given one it refuses", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-relay-"));
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    const base = `http://127.0.0.1:${server.port}`;
    const { token } = (await (
      await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
      })
    ).json()) as { token: string };
    const rtcConfig = async () =>
      (
        (await (
          await fetch(`${base}/api/rtc-config`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as { iceServers: unknown[] }
      ).iceServers;

    const relay: CallRelay = {
      kind: "custom",
      urls: ["turn:turn.example.org:3478", "turns:turn.example.org:5349"],
      username: "workspace",
      credential: "secret",
    };
    server.setRelay(relay);
    expect(await rtcConfig()).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: ["turn:turn.example.org:3478", "turns:turn.example.org:5349"],
        username: "workspace",
        credential: "secret",
      },
    ]);
    expect(() =>
      server!.setRelay({ ...relay, urls: ["https://turn.example.org"] } as CallRelay),
    ).toThrow();
    expect(await rtcConfig()).toHaveLength(2);
    expect(server.relayError()).toBeNull();
    server.setRelay(null);
    expect(await rtcConfig()).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });

  it("signs each member who asks a password of their own from a shared secret", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-relay-"));
    const relay: ServerRelay = {
      kind: "shared-secret",
      urls: ["turn:turn.example.org:3478"],
      secret: "the-shared-secret-16",
    };
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
      relay,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const register = async (handle: string) =>
      (await (
        await fetch(`${base}/api/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
        })
      ).json()) as { token: string; user: { id: string } };
    const owner = await register("owner");
    const member = await register("member");
    const relayFor = async (token: string) => {
      const response = await fetch(`${base}/api/rtc-config`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { iceServers } = (await response.json()) as {
        iceServers: { urls: string[]; username: string; credential: string }[];
      };
      expect(iceServers).toHaveLength(1);
      return iceServers[0]!;
    };

    const before = Math.floor(Date.now() / 1000);
    for (const { token, user } of [owner, member]) {
      const given = await relayFor(token);
      expect(given.urls).toEqual(relay.urls);
      const [expires, id] = given.username.split(":");
      expect(id).toBe(user.id);
      expect(Number(expires) - before).toBeGreaterThanOrEqual(24 * 60 * 60);
      expect(Number(expires) - before).toBeLessThan(24 * 60 * 60 + 60);
      expect(given.credential).toBe(
        createHmac("sha1", relay.secret).update(given.username).digest("base64"),
      );
    }
    expect((await fetch(`${base}/api/rtc-config`)).status).toBe(401);
    // Refused before anything changes, so calls keep the relay they had.
    expect(() => server!.setRelay({ ...relay, secret: "too-short-1" })).toThrow();
    expect((await relayFor(owner.token)).urls).toEqual(relay.urls);
  });
});
