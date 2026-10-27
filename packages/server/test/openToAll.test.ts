import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";

/**
 * What a desktop host changes while its workspace runs, when it opens the
 * workspace to all through a tunnel and closes it again.
 */
describe("a workspace opened to all while it runs", () => {
  let server: WorkspaceServer | undefined;
  let dataDir: string | undefined;
  let base = "";

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function start() {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-open-"));
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function serverInfo() {
    return (await (await fetch(`${base}/api/server-info`)).json()) as {
      publicUrl?: string;
      requiresInvite: boolean;
      requiresClaim: boolean;
    };
  }

  function register(handle: string, extra: Record<string, string> = {}) {
    return fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, displayName: handle, password: "password123", ...extra }),
    });
  }

  it("tells clients the address it was given, and stops once it is taken away", async () => {
    await start();
    expect((await serverInfo()).publicUrl).toBeUndefined();
    server!.setPublicUrl("https://open-to-all-test.trycloudflare.com/");
    expect((await serverInfo()).publicUrl).toBe("https://open-to-all-test.trycloudflare.com");
    server!.setPublicUrl(null);
    expect((await serverInfo()).publicUrl).toBeUndefined();
  });

  it("stops treating this machine as local while it is reachable through the tunnel", async () => {
    await start();
    // Through a tunnel every request arrives from this machine, so an
    // ownerless workspace must ask for its claim code from everyone.
    server!.setPublicUrl("https://open-to-all-test.trycloudflare.com");
    expect((await serverInfo()).requiresClaim).toBe(true);
    const refused = await register("owner");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("claim_required");
    server!.setPublicUrl(null);
    expect((await register("owner")).status).toBe(201);
  });

  it("keeps the address it had when given one it must not publish", async () => {
    await start();
    server!.setPublicUrl("https://open-to-all-test.trycloudflare.com");
    expect(() => server!.setPublicUrl("https://user:secret@example.com")).toThrow(/username/);
    expect(() => server!.setPublicUrl("chat.example.com")).toThrow(/full address/);
    expect((await serverInfo()).publicUrl).toBe("https://open-to-all-test.trycloudflare.com");
  });

  it("gives calls started afterwards the STUN servers it was given, and refuses others", async () => {
    await start();
    const { token } = (await (await register("owner")).json()) as { token: string };
    const rtcConfig = async () =>
      (await (
        await fetch(`${base}/api/rtc-config`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { iceServers: unknown[] };
    expect((await rtcConfig()).iceServers).toEqual([]);
    server!.setIceServers([{ urls: "stun:stun.cloudflare.com:3478" }]);
    expect((await rtcConfig()).iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
    expect(() => server!.setIceServers([{ urls: "https://not-a-stun-server.example" }])).toThrow();
    expect((await rtcConfig()).iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
    server!.setIceServers([]);
    expect((await rtcConfig()).iceServers).toEqual([]);
  });

  it("asks for an invite code once told to, and stops asking once told not to", async () => {
    await start();
    const { token } = (await (await register("owner")).json()) as { token: string };
    expect(server!.inviteOnly()).toBe(false);
    server!.setInviteOnly(true);
    expect(server!.inviteOnly()).toBe(true);
    expect((await serverInfo()).requiresInvite).toBe(true);
    const refused = await register("stranger");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("invite_required");
    const { invite } = (await (
      await fetch(`${base}/api/invites`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { invite: { code: string } };
    expect((await register("friend", { inviteCode: invite.code })).status).toBe(201);
    server!.setInviteOnly(false);
    expect((await serverInfo()).requiresInvite).toBe(false);
    expect((await register("anyone")).status).toBe(201);
  });

  it("refuses a non-boolean invite policy without changing the current one", async () => {
    await start();
    server!.setInviteOnly(true);
    expect(() => (server!.setInviteOnly as (value: unknown) => void)("false")).toThrow(/boolean/);
    expect(server!.inviteOnly()).toBe(true);
  });
});
