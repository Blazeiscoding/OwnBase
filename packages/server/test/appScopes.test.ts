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
    const owner = store.createUser({
      handle: "owner",
      displayName: "Owner",
      passwordHash: "unused",
      salt: "unused",
      role: "owner",
    });
    const bot = store.createBotUser("deploy-bot", "Deploy Bot", "unused", "unused");
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
      expect(new Store(upgraded).getApp("A_OLD")!.scopes).toEqual([
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
