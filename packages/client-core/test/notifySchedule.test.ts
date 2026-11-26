import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import type { Message, NotifySchedule } from "@ownbase/protocol";
import {
  Api,
  ApiError,
  WorkspaceClient,
  decideNotification,
  decideReminderNotification,
} from "../src/index.js";
import type { WorkspaceState } from "../src/index.js";

/**
 * The hours an account allows notifications (K12): kept on the server, in the
 * snapshot, changed from one device and known on the others, and followed by
 * the app's own notifications.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let token: string;

function until(
  client: WorkspaceClient,
  predicate: (s: WorkspaceState) => boolean,
  label = "condition",
  timeoutMs = 5000,
): Promise<WorkspaceState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const unsubscribe = client.store.subscribe((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      }
    });
  });
}

async function online() {
  const client = new WorkspaceClient(base, token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  return client;
}

const WORK = { from: "09:00", to: "18:00" };
const weekdays: NotifySchedule = {
  kind: "weekdays",
  days: [null, WORK, WORK, WORK, WORK, WORK, null],
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-notify-schedule-"));
  server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
  base = `http://127.0.0.1:${server.port}`;
  token = (
    await new Api(base).register({ handle: "sam", displayName: "Sam", password: "password123" })
  ).token;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the notification schedule", () => {
  it("arrives with the snapshot, and a change reaches the account's other devices", async () => {
    const laptop = await online();
    const phone = await online();
    expect(laptop.state.notifySchedule).toBeNull();

    expect(await laptop.setNotifySchedule(weekdays)).toBeNull();
    expect(laptop.state.notifySchedule).toEqual(weekdays);
    await until(phone, (s) => s.notifySchedule?.kind === "weekdays", "the phone hearing of it");
    const later = await online();
    expect(later.state.notifySchedule).toEqual(weekdays);

    expect(await laptop.setNotifySchedule(null)).toBeNull();
    expect(laptop.state.notifySchedule).toBeNull();
    await until(phone, (s) => s.notifySchedule === null, "the schedule turned off");
  });

  it("is shown at once, and put back when the server refuses", async () => {
    const client = await online();
    let refuse = () => {};
    vi.spyOn(client.api, "setNotifySchedule").mockImplementation(
      () => new Promise((_, reject) => (refuse = () => reject(new ApiError(500, "internal")))),
    );
    const saving = client.setNotifySchedule(weekdays);
    expect(client.state.notifySchedule).toEqual(weekdays);
    refuse();
    expect(await saving).toBeInstanceOf(ApiError);
    expect(client.state.notifySchedule).toBeNull();
  });

  it("keeps the app's own notifications back outside the hours, in the account's zone", async () => {
    const client = await online();
    const self = client.state.self!;
    const general = server.store.channels.byName("general")!.id;
    const state: WorkspaceState = {
      ...client.state,
      self: { ...self, timeZone: "Asia/Kolkata" },
      notifySchedule: weekdays,
    };
    const message = {
      id: "M1",
      channelId: general,
      userId: "someone-else",
      text: `<@${self.id}> are you there`,
      threadRootId: null,
      replyTo: null,
    } as unknown as Message;
    // Monday 20:00 in Kolkata, then 10:00.
    const evening = Date.parse("2026-11-23T14:30:00Z");
    const morning = Date.parse("2026-11-23T04:30:00Z");
    expect(decideNotification(state, message, { now: evening }).reason).toBe("schedule");
    expect(decideNotification(state, message, { now: morning }).reason).toBe("mention");
    expect(decideReminderNotification(state, evening).reason).toBe("schedule");
    expect(decideReminderNotification(state, morning).reason).toBe("reminder");
  });
});
