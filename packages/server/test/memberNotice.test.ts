import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  planMembers,
  type MemberNotice,
  type ServerToClient,
  type User,
} from "@slackoss/protocol";
import { ConfigError, parseMemberNotice } from "../src/config.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A plan's member notice (P5): the host says how many members the plan
 * includes, and the owner and admins are told, in the snapshot they sync,
 * so they can offer a bigger plan past it. It is a notice, never a limit.
 */
let server: WorkspaceServer | undefined;
let base: string;
const sockets: WebSocket[] = [];
type Account = { token: string; user: User };

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
});

async function start(memberNotice?: MemberNotice) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    ...(memberNotice ? { memberNotice } : {}),
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
  return { status: response.status, data: (await response.json()) as any };
}

async function register(handle: string, inviteCode?: string): Promise<Account> {
  const { status, data } = await call("/api/auth/register", undefined, {
    handle,
    displayName: handle,
    password: "password123",
    ...(inviteCode ? { inviteCode } : {}),
  });
  expect(status, handle).toBe(201);
  return data;
}

async function ready(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return frames.find((f) => f.type === "ready") as Extract<ServerToClient, { type: "ready" }>;
}

const TEAM: MemberNotice = {
  members: 2,
  planName: "Team",
  upgradeUrl: "https://example.com/plans?workspace=w1",
};

describe("the member notice", () => {
  it("is given to the owner and admins, and to nobody else", async () => {
    await start(TEAM);
    const owner = await register("owner");
    const admin = await register("admin");
    const member = await register("member");
    expect(
      (await call(`/api/admin/users/${admin.user.id}`, owner.token, { role: "admin" }, "PATCH"))
        .status,
    ).toBe(200);
    expect((await ready(owner.token)).memberNotice).toEqual(TEAM);
    expect((await ready(admin.token)).memberNotice).toEqual(TEAM);
    expect((await ready(member.token)).memberNotice).toBeUndefined();
    server!.setAccessPolicy("guest_allowed");
    const guest = (await call("/api/auth/guest", undefined, { displayName: "Visitor" })).data;
    expect((await ready(guest.token)).memberNotice).toBeUndefined();
  });

  it("locks nobody out: people keep joining and signing in past it", async () => {
    await start({ members: 1 });
    const owner = await register("owner");
    for (const handle of ["two", "three", "four"]) await register(handle);
    // Invited, as an invite-only workspace joins.
    const code = (await call("/api/invites", owner.token, { maxUses: 1 })).data.invite.code;
    await register("five", code);
    const login = await call("/api/auth/login", undefined, {
      handle: "five",
      password: "password123",
    });
    expect(login.status).toBe(200);
    const snapshot = await ready(owner.token);
    expect(planMembers(snapshot.users)).toBe(5);
    expect(snapshot.memberNotice).toEqual({ members: 1 });
  });

  it("is not sent where the host set no plan", async () => {
    await start();
    const owner = await register("owner");
    expect("memberNotice" in (await ready(owner.token))).toBe(false);
  });
});

describe("counting a plan's members", () => {
  const person = (over: Partial<User>): User => ({
    id: "u",
    handle: "u",
    displayName: "u",
    role: "member",
    statusText: "",
    statusEmoji: "",
    isBot: false,
    deactivated: false,
    dndUntil: null,
    createdAt: 0,
    ...over,
  });

  it("counts people who can sign in, not apps, guests or deactivated accounts", () => {
    expect(
      planMembers([
        person({ role: "owner" }),
        person({ role: "admin" }),
        person({}),
        person({ isBot: true }),
        person({ role: "guest" }),
        person({ deactivated: true }),
      ]),
    ).toBe(3);
  });
});

describe("the settings", () => {
  it("take the number alone, or with a plan's name and where to choose a bigger one", () => {
    expect(
      parseMemberNotice({ members: undefined, planName: undefined, upgradeUrl: undefined }),
    ).toBeUndefined();
    expect(
      parseMemberNotice({ members: " 50 ", planName: undefined, upgradeUrl: undefined }),
    ).toEqual({ members: 50 });
    expect(
      parseMemberNotice({
        members: "50",
        planName: "  Team ",
        upgradeUrl: "https://example.com/plans?w=1#more",
      }),
    ).toEqual({ members: 50, planName: "Team", upgradeUrl: "https://example.com/plans?w=1#more" });
  });

  it("are refused, naming the setting, when they cannot be used", () => {
    const parse = (members?: string, planName?: string, upgradeUrl?: string) => () =>
      parseMemberNotice({ members, planName, upgradeUrl });
    for (const [bad, message] of [
      [parse(undefined, "Team"), "need --member-notice"],
      [parse(undefined, undefined, "https://example.com"), "need --member-notice"],
      [parse("0"), "--member-notice must be at least 1"],
      [parse("2.5"), "--member-notice needs a whole number"],
      [parse("fifty"), "--member-notice needs a whole number"],
      [parse("50", "   "), "--plan-name needs the plan's name"],
      [parse("50", "x".repeat(41)), "--plan-name needs the plan's name"],
      [parse("50", "Team\nplan"), "--plan-name needs the plan's name"],
      [parse("50", undefined, "example.com/plans"), "--upgrade-url needs a full address"],
      [parse("50", undefined, "javascript:alert(1)"), "--upgrade-url must start with https://"],
      [parse("50", undefined, "https://me:secret@example.com"), "must not contain a username"],
    ] as const) {
      expect(bad, message).toThrow(ConfigError);
      expect(bad).toThrow(message);
    }
  });
});

describe("the command line", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  function cli(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", main, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
  const dataDirs: string[] = [];
  afterEach(() => {
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const serverArgs = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ownbase-notice-"));
    dataDirs.push(dataDir);
    return ["--data", dataDir, "--port", "0", "--host", "127.0.0.1", "--no-mdns"];
  };

  it("refuses a plan's name without the number", async () => {
    const run = cli([...serverArgs(), "--plan-name", "Team"]);
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("need --member-notice");
  }, 30_000);

  it("says the plan on starting, set by flags or by the environment", async () => {
    for (const [args, env, said] of [
      [["--member-notice", "50", "--plan-name", "Team"], {}, "the Team plan includes 50"],
      [
        [],
        { OWNBASE_MEMBER_NOTICE: "200", OWNBASE_UPGRADE_URL: "https://example.com" },
        "the plan includes 200",
      ],
    ] as const) {
      const run = cli([...serverArgs(), ...args], env);
      try {
        await vi.waitFor(
          () =>
            expect(run.output()).toContain(
              `Members: ${said}; past that, the owner and admins are told`,
            ),
          { timeout: 20_000 },
        );
      } finally {
        run.child.kill();
        await run.exited;
      }
    }
  }, 60_000);
});
