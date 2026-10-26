import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import {
  cloudflareIceServers,
  createRelaySource,
  relayFromEnvironment,
  withRelay,
  type CallRelay,
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
    const [first, second] = await Promise.all([source.servers(), source.servers()]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 59 * 60 * 1000;
    await source.servers();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 61 * 60 * 1000;
    await source.servers();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives no relay for a while after a refusal, and says why until one works", async () => {
    let now = 0;
    let refuse = true;
    const fetch = vi.fn(async () => (refuse ? answer({}, 401) : answer(offered)));
    const onError = vi.fn();
    const source = createRelaySource(cloudflare, { fetch, now: () => now, onError });
    expect(await source.servers()).toEqual([]);
    expect(source.error()).toBe("Cloudflare refused the API token for this TURN key.");
    expect(onError).toHaveBeenCalledTimes(1);
    now = 10_000;
    expect(await source.servers()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    refuse = false;
    now = 31_000;
    expect(await source.servers()).toHaveLength(2);
    expect(source.error()).toBeNull();
  });

  it("gives another relay as it was set, and nothing without one", async () => {
    const custom: CallRelay = {
      kind: "custom",
      urls: ["turn:turn.example.org:3478"],
      username: "workspace",
      credential: "secret",
    };
    expect(await createRelaySource(custom).servers()).toEqual([
      { urls: ["turn:turn.example.org:3478"], username: "workspace", credential: "secret" },
    ]);
    expect(await createRelaySource(null).servers()).toEqual([]);
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
});
