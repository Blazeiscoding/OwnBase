import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepeatRule } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Repeating scheduled messages (K14): each send queues the next by the rule,
 * on the author's wall clock, through restarts, until stopped.
 *
 * Only Date is faked, so the server's sockets and timers run as ever while
 * the clock is moved from one send to the next.
 */
let server: WorkspaceServer | undefined;
let base: string;
let dataDir: string;

async function start() {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function stop() {
  await server?.stop();
  server = undefined;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-repeat-"));
});

afterEach(async () => {
  await stop();
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

async function request(path: string, token: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function register(handle: string) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, id: body.user.id };
}

const at = (iso: string) => Date.parse(iso);
const iso = (instant: number) => new Date(instant).toISOString();
const general = () => server!.store.channels.byName("general")!.id;
const weekdays: RepeatRule = {
  every: "weekday",
  time: "09:00",
  timeZone: "Europe/London",
  until: null,
};
const schedule = (token: string, body: Record<string, unknown>, channelId = general()) =>
  request(`/api/channels/${channelId}/scheduled`, token, { text: "Standup notes", ...body });
const posted = (channelId = general()) =>
  server!.store.messages
    .list({ channelId, limit: 100 })
    .map((m) => ({ text: m.text, at: iso(m.createdAt) }))
    .sort((a, b) => a.at.localeCompare(b.at));
/** Moves the clock to `when` and runs the flush the timer would. */
const runAt = (when: string) => {
  vi.setSystemTime(at(when));
  server!.flushScheduled();
};

describe("every weekday at 9:00", () => {
  it("posts Monday to Friday at 9:00 in London, across the clocks going forward, and skips the weekend", async () => {
    // Thursday 26 March 2026. The clocks go forward on Sunday the 29th.
    vi.setSystemTime(at("2026-03-26T12:00:00Z"));
    await start();
    const owner = await register("owner");
    const made = await schedule(owner.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: weekdays,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.scheduled.repeat).toEqual(weekdays);
    const id = made.body.scheduled.id as string;
    const next = () => iso(server!.store.scheduled.get(id)!.sendAt);

    runAt("2026-03-27T09:00:00Z"); // Friday, 9:00 GMT
    expect(next()).toBe("2026-03-30T08:00:00.000Z"); // Monday, 9:00 BST
    runAt("2026-03-28T09:00:00Z"); // Saturday: nothing is due
    runAt("2026-03-29T09:00:00Z"); // Sunday
    for (const day of ["30", "31"]) runAt(`2026-03-${day}T08:00:00Z`);
    for (const day of ["01", "02", "03"]) runAt(`2026-04-${day}T08:00:00Z`);
    runAt("2026-04-04T08:00:00Z"); // Saturday again

    expect(posted().map((m) => m.at)).toEqual([
      "2026-03-27T09:00:00.000Z",
      "2026-03-30T08:00:00.000Z",
      "2026-03-31T08:00:00.000Z",
      "2026-04-01T08:00:00.000Z",
      "2026-04-02T08:00:00.000Z",
      "2026-04-03T08:00:00.000Z",
    ]);
    expect(new Set(posted().map((m) => m.text))).toEqual(new Set(["Standup notes"]));
    // Still waiting, for Monday, with the last message it sent.
    const waiting = server!.store.scheduled.get(id)!;
    expect(waiting).toMatchObject({ status: "queued", repeat: weekdays });
    expect(iso(waiting.sendAt)).toBe("2026-04-06T08:00:00.000Z");
    expect(iso(server!.store.messages.get(waiting.messageId!)!.createdAt)).toBe(
      "2026-04-03T08:00:00.000Z",
    );
  });

  it("starts on the Monday when the time chosen is on a weekend", async () => {
    vi.setSystemTime(at("2026-03-27T12:00:00Z"));
    await start();
    const owner = await register("owner");
    const made = await schedule(owner.token, {
      sendAt: at("2026-03-28T09:00:00Z"),
      repeat: weekdays,
    });
    expect(iso(made.body.scheduled.sendAt)).toBe("2026-03-30T08:00:00.000Z");
  });

  it("goes at 9:00 in Asia/Kolkata", async () => {
    vi.setSystemTime(at("2026-03-26T12:00:00Z"));
    await start();
    const owner = await register("owner");
    const made = await schedule(owner.token, {
      sendAt: at("2026-03-27T03:30:00Z"),
      repeat: { ...weekdays, timeZone: "Asia/Calcutta" },
    });
    // Kept under the zone's current name, as a profile's zone is.
    expect(made.body.scheduled.repeat.timeZone).toBe("Asia/Kolkata");
    runAt("2026-03-27T03:30:00Z");
    expect(iso(server!.store.scheduled.get(made.body.scheduled.id)!.sendAt)).toBe(
      "2026-03-30T03:30:00.000Z",
    );
  });
});

describe("through a restart", () => {
  it("keeps the next send queued, and sends what came due while stopped once, not once per day missed", async () => {
    vi.setSystemTime(at("2026-03-26T12:00:00Z"));
    await start();
    const owner = await register("owner");
    const made = await schedule(owner.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: weekdays,
    });
    const id = made.body.scheduled.id as string;
    runAt("2026-03-27T09:00:00Z");
    await stop();

    // Down over the weekend, Monday and Tuesday; back on Wednesday at 10:00.
    vi.setSystemTime(at("2026-04-01T09:00:00Z"));
    await start();
    // Starting sends what came due, without waiting for the timer.
    await vi.waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted()[1]!.at).toBe("2026-04-01T09:00:00.000Z");
    const waiting = server!.store.scheduled.get(id)!;
    expect(waiting).toMatchObject({ status: "queued", repeat: weekdays });
    expect(iso(waiting.sendAt)).toBe("2026-04-02T08:00:00.000Z");

    await stop();
    vi.setSystemTime(at("2026-04-01T12:00:00Z"));
    await start();
    runAt("2026-04-02T08:00:00Z");
    expect(posted().map((m) => m.at)).toEqual([
      "2026-03-27T09:00:00.000Z",
      "2026-04-01T09:00:00.000Z",
      "2026-04-02T08:00:00.000Z",
    ]);
  });
});

describe("changing one that repeats", () => {
  it("sent now by hand, does not send again at today's time", async () => {
    vi.setSystemTime(at("2026-03-30T07:59:00Z")); // Monday, 8:59 BST
    await start();
    const owner = await register("owner");
    const made = await schedule(owner.token, {
      sendAt: at("2026-03-30T08:00:00Z"),
      repeat: weekdays,
    });
    const id = made.body.scheduled.id as string;
    await request(`/api/scheduled/${id}`, owner.token, { sendAt: Date.now() }, "PATCH");
    server!.flushScheduled();
    expect(posted()).toHaveLength(1);
    expect(iso(server!.store.scheduled.get(id)!.sendAt)).toBe("2026-03-31T08:00:00.000Z");
  });

  it("stops repeating from Scheduled: the waiting send still goes, once", async () => {
    vi.setSystemTime(at("2026-03-26T12:00:00Z"));
    await start();
    const owner = await register("owner");
    const other = await register("other");
    const made = await schedule(owner.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: weekdays,
    });
    const id = made.body.scheduled.id as string;
    // Only its author can.
    expect(
      (await request(`/api/scheduled/${id}/repeat`, other.token, undefined, "DELETE")).status,
    ).toBe(404);

    const stopped = await request(`/api/scheduled/${id}/repeat`, owner.token, undefined, "DELETE");
    expect(stopped.status).toBe(200);
    expect(stopped.body.scheduled).toMatchObject({ status: "queued", repeat: null });
    expect(iso(stopped.body.scheduled.sendAt)).toBe("2026-03-27T09:00:00.000Z");
    // Asked again, the same answer.
    expect(
      (await request(`/api/scheduled/${id}/repeat`, owner.token, undefined, "DELETE")).status,
    ).toBe(200);

    runAt("2026-03-27T09:00:00Z");
    runAt("2026-03-30T08:00:00Z");
    expect(posted()).toHaveLength(1);
    expect((await request("/api/scheduled", owner.token, undefined, "GET")).body.scheduled).toEqual(
      [],
    );
  });

  it("ends after its end date", async () => {
    vi.setSystemTime(at("2026-03-26T12:00:00Z"));
    await start();
    const owner = await register("owner");
    const made = await schedule(owner.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: { ...weekdays, until: "2026-03-30" },
    });
    runAt("2026-03-27T09:00:00Z");
    runAt("2026-03-30T08:00:00Z");
    runAt("2026-03-31T08:00:00Z");
    expect(posted()).toHaveLength(2);
    expect(server!.store.scheduled.get(made.body.scheduled.id)!.status).toBe("sent");
  });
});

describe("refusing a repeat that cannot work", () => {
  it("refuses files, and an end date before the first send", async () => {
    vi.setSystemTime(at("2026-03-26T12:00:00Z"));
    await start();
    const owner = await register("owner");
    const withFiles = await schedule(owner.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: weekdays,
      fileIds: ["F1"],
    });
    expect(withFiles.status).toBe(400);
    expect(withFiles.body.error).toBe("repeat_with_files");
    const ended = await schedule(owner.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: { ...weekdays, until: "2026-03-26" },
    });
    expect(ended.status).toBe(400);
    expect(ended.body.error).toBe("repeat_ends_before_start");
    // A weekly rule names its day.
    const unnamed = await schedule(owner.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: { ...weekdays, every: "week" },
    });
    expect(unnamed.status).toBe(400);
    expect(server!.store.scheduled.list(owner.id)).toEqual([]);
  });
});

describe("when its author can no longer post there", () => {
  it("stops when they leave the channel, says why, and does not start again when they rejoin", async () => {
    vi.setSystemTime(at("2026-03-26T12:00:00Z"));
    await start();
    const owner = await register("owner");
    const member = await register("member");
    const made = await schedule(member.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: weekdays,
    });
    const once = await schedule(member.token, { sendAt: at("2026-03-27T09:00:00Z") });
    expect((await request(`/api/channels/${general()}/leave`, member.token)).status).toBe(200);

    const stopped = server!.store.scheduled.get(made.body.scheduled.id)!;
    expect(stopped).toMatchObject({
      status: "failed",
      repeat: null,
      failureReason: "It stopped repeating because you are no longer in that channel.",
    });
    // A message sent once is not a repeat: it waits as before.
    expect(server!.store.scheduled.get(once.body.scheduled.id)!.status).toBe("queued");

    expect((await request(`/api/channels/${general()}/join`, member.token)).status).toBe(200);
    runAt("2026-03-27T09:00:00Z");
    // The message sent once goes; the stopped repeat does not.
    expect(posted()).toHaveLength(1);
    expect(server!.store.scheduled.get(made.body.scheduled.id)!.status).toBe("failed");
    expect(server!.store.scheduled.get(once.body.scheduled.id)!.status).toBe("sent");
  });

  it("stops when their account is deactivated", async () => {
    vi.setSystemTime(at("2026-03-26T12:00:00Z"));
    await start();
    await register("owner");
    const member = await register("member");
    const made = await schedule(member.token, {
      sendAt: at("2026-03-27T09:00:00Z"),
      repeat: weekdays,
    });
    server!.store.people.update(member.id, { deactivated: true });
    expect(server!.store.scheduled.get(made.body.scheduled.id)).toMatchObject({
      status: "failed",
      repeat: null,
      failureReason: "It stopped repeating because your account was deactivated.",
    });
    server!.store.people.update(member.id, { deactivated: false });
    runAt("2026-03-27T09:00:00Z");
    expect(posted()).toEqual([]);
  });
});

describe("/remind and an app's own /remind", () => {
  it("is the app's own command, refused by the server, unless an app had the name before", async () => {
    vi.useRealTimers();
    await start();
    const owner = await register("owner");
    const listed = async () =>
      (
        (await request("/api/commands", owner.token, undefined, "GET")).body.commands as any[]
      ).filter((c) => c.command === "remind");
    expect(await listed()).toEqual([expect.objectContaining({ builtin: true })]);
    const sent = await request(`/api/channels/${general()}/commands`, owner.token, {
      text: "/remind #general hi every day at 9",
    });
    expect(sent.body.error).toBe("in_app_command");

    // No app can claim it now...
    const app = await request("/api/apps", owner.token, { name: "Nagger", scopes: ["chat:write"] });
    expect(app.status, JSON.stringify(app.body)).toBeLessThan(300);
    const appId = (app.body.app?.id ?? app.body.id) as string;
    const claimed = await request(`/api/apps/${appId}/commands`, owner.token, {
      command: "remind",
      url: "https://example.com/remind",
    });
    expect(claimed.status).toBe(409);
    // ...but one that had it before /remind was the app's keeps it.
    server!.store.apps.createCommand({
      appId,
      command: "remind",
      url: "https://example.com/remind",
      description: "Their reminders",
      usageHint: "",
    });
    expect(await listed()).toEqual([
      expect.objectContaining({ builtin: false, description: "Their reminders" }),
    ]);
  });
});
