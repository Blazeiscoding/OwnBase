import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { User } from "@ownbase/protocol";
import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";

/**
 * The channels a handshake lists read their managers and conversation members
 * once for all of them (OPT-13), where each used to ask for its own. The list
 * must say exactly what asking for each channel on its own says.
 */
let directory: string;
let db: DatabaseSync;
let store: Store;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-snapshot-channels-"));
  db = openDb(join(directory, "workspace.db"));
  store = new Store(db);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

const person = (handle: string): User =>
  store.createUser({ handle, displayName: handle, passwordHash: "", salt: "", role: "member" });

describe("the channels listed at a handshake", () => {
  it("carry the same managers and members as each channel read on its own", () => {
    const [ana, ben, cai, dee] = ["ana", "ben", "cai", "dee"].map(person) as [
      User,
      User,
      User,
      User,
    ];
    const managed = store.channels.create({
      type: "public",
      name: "managed",
      creatorId: ana.id,
      memberIds: [ana.id, ben.id, cai.id],
    });
    store.channels.setChannelManager(managed.id, cai.id, true);
    store.channels.setChannelManager(managed.id, ana.id, true);
    store.channels.create({
      type: "public",
      name: "nobody-manages",
      creatorId: ben.id,
      memberIds: [ben.id],
    });
    const plans = store.channels.create({
      type: "private",
      name: "plans",
      creatorId: ana.id,
      memberIds: [ana.id, dee.id],
    });
    store.channels.setChannelManager(plans.id, dee.id, true);
    // One ana is not in, whose manager she must not be told of by way of it.
    const hidden = store.channels.create({
      type: "private",
      name: "hidden",
      creatorId: ben.id,
      memberIds: [ben.id],
    });
    store.channels.setChannelManager(hidden.id, ben.id, true);
    store.channels.create({
      type: "dm",
      creatorId: ana.id,
      memberIds: [dee.id, ana.id],
      dmKey: [ana.id, dee.id].sort().join(":"),
    });
    store.channels.create({
      type: "group_dm",
      creatorId: cai.id,
      memberIds: [cai.id, ana.id, ben.id],
    });
    // One dee has left: listed to those still in it, as they are now.
    const left = store.channels.create({
      type: "group_dm",
      creatorId: ben.id,
      memberIds: [ben.id, cai.id, dee.id],
    });
    store.channels.removeMember(left.id, dee.id);
    store.channels.create({
      type: "dm",
      creatorId: ben.id,
      memberIds: [ben.id, cai.id],
      dmKey: "x",
    });

    for (const reader of [ana, ben, cai, dee]) {
      const listed = store.channels.visibleTo(reader.id);
      expect(listed).toEqual(listed.map((c) => store.channels.get(c.id)));
    }
    const ana_ = store.channels.visibleTo(ana.id);
    expect(ana_.map((c) => c.name).filter(Boolean)).toEqual(["managed", "nobody-manages", "plans"]);
    expect(ana_.find((c) => c.id === managed.id)?.managerIds).toEqual([ana.id, cai.id].sort());
    expect(ana_.filter((c) => c.type === "dm" || c.type === "group_dm")).toHaveLength(2);
  });
});
