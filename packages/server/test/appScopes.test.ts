import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openDbAtVersion } from "../src/db.js";
import { Store } from "../src/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("an app made before scopes (E18c)", () => {
  it("can still do everything it could after the upgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "ownbase-scopes-"));
    dirs.push(dir);
    const path = join(dir, "workspace.db");

    // Schema v50, the last before scopes: an app row as that server wrote it.
    const old = openDbAtVersion(path, 50);
    const store = new Store(old);
    const owner = store.people.create({
      handle: "owner",
      displayName: "Owner",
      passwordHash: "unused",
      salt: "unused",
      role: "owner",
    });
    const bot = store.apps.createBotUser("deploy-bot", "Deploy Bot", "unused", "unused");
    old
      .prepare(
        "INSERT INTO apps (id, name, bot_user_id, created_by, created_at, signing_secret) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("A_OLD", "Deploy Bot", bot.id, owner.id, 0, "secret");
    old.close();

    const upgraded = openDb(path);
    try {
      // The scopes there were at v51. One added later is not given to old
      // apps: that is what asking for it is for.
      expect(new Store(upgraded).apps.get("A_OLD")!.scopes).toEqual([
        "chat:write",
        "chat:write.public",
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
        "channels:read",
        "groups:read",
        "reactions:read",
        "pins:read",
        "users:read",
      ]);
    } finally {
      upgraded.close();
    }
  });
});

describe("a subscription's stored event types", () => {
  it("are read as the known types they name, and as none when the column is not a list", () => {
    const dir = mkdtempSync(join(tmpdir(), "ownbase-events-"));
    dirs.push(dir);
    const db = openDb(join(dir, "workspace.db"));
    try {
      const store = new Store(db);
      const owner = store.people.create({
        handle: "owner",
        displayName: "Owner",
        passwordHash: "unused",
        salt: "unused",
        role: "owner",
      });
      const bot = store.apps.createBotUser("deploy-bot", "Deploy Bot", "unused", "unused");
      const app = store.apps.create({
        name: "Deploy Bot",
        botUserId: bot.id,
        createdBy: owner.id,
        signingSecret: "secret",
        scopes: ["chat:write"],
      });
      const sub = store.apps.createSubscription({
        appId: app.id,
        url: "https://bot.example.com/events",
        eventTypes: ["pin.added"],
      });
      const stored = db.prepare("UPDATE event_subscriptions SET event_types = ? WHERE id = ?");

      stored.run(JSON.stringify(["pin.added", "no.such_event", 7]), sub.id);
      expect(store.apps.getSubscription(sub.id)!.eventTypes).toEqual(["pin.added"]);
      stored.run("not json", sub.id);
      expect(store.apps.listSubscriptions(app.id)[0]!.eventTypes).toEqual([]);
      expect(store.apps.allSubscriptions()).toMatchObject([
        {
          subscription: { id: sub.id, eventTypes: [] },
          app: { id: app.id, scopes: ["chat:write"] },
        },
      ]);
    } finally {
      db.close();
    }
  });
});
