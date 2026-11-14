import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseSearchQuery } from "@ownbase/protocol";
import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";

/**
 * Chinese, Japanese and Thai put no spaces between words, and Korean often
 * runs a compound together. A search for a word from the middle of such a
 * sentence finds it, and English and accented words are found as before.
 */
let directory: string;
let db: DatabaseSync;
let store: Store;
let reader: string;
let channel: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-search-languages-"));
  db = openDb(join(directory, "workspace.db"));
  store = new Store(db);
  reader = store.people.create({
    handle: "ana",
    displayName: "Ana",
    passwordHash: "",
    salt: "",
    role: "member",
  }).id;
  channel = store.channels.create({
    type: "public",
    name: "general",
    creatorId: reader,
    memberIds: [reader],
  }).id;
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function post(text: string): string {
  return store.messages.create({
    channelId: channel,
    userId: reader,
    text,
    threadRootId: null,
    nonce: null,
  });
}

/** The words of every message the search finds, newest first. */
function find(query: string): string[] {
  return store.search
    .search(reader, parseSearchQuery(query, { timeZone: "UTC" }), 50)
    .map((m) => m.text);
}

describe("words inside a sentence written without spaces", () => {
  it.each([
    ["Chinese", "我们明天部署新版本", ["部署", "版本", "明天"]],
    ["Japanese", "明日新しいバージョンをデプロイします", ["デプロイ", "バージョン", "新しい"]],
    ["Korean", "신규버전을 배포합니다", ["버전", "배포"]],
    ["Thai", "พรุ่งนี้เราจะปรับใช้เวอร์ชันใหม่", ["ปรับใช้", "เวอร์ชัน"]],
  ])("finds a %s message by a word from its middle", (_, text, words) => {
    post(text);
    post("something else entirely");
    for (const word of words) expect(find(word), word).toEqual([text]);
  });

  it("finds a two-character word that is not the last one searched for", () => {
    post("我们明天部署新版本");
    expect(find("部署 版本")).toEqual(["我们明天部署新版本"]);
  });

  it("needs the characters searched for side by side, in that order", () => {
    post("我们明天部署新版本");
    expect(find("部版")).toEqual([]);
    expect(find("署部")).toEqual([]);
  });

  it("finds an English word inside a Japanese sentence", () => {
    post("明日のdeployは延期します");
    expect(find("deploy")).toEqual(["明日のdeployは延期します"]);
    expect(find("延期")).toEqual(["明日のdeployは延期します"]);
  });

  it("still finds links, mentions, shortcodes and code among Japanese words", () => {
    const text = "設定は`config.yaml`です :tada: https://example.com/手順 <@U1>";
    post(text);
    expect(find("config.yaml")).toEqual([text]);
    expect(find("tada")).toEqual([text]);
    expect(find("example.com")).toEqual([text]);
    expect(find("手順")).toEqual([text]);
    expect(find("設定")).toEqual([text]);
  });
});

describe("other forms of a word", () => {
  it("finds an accented word searched without the accent", () => {
    post("meet at the café at noon");
    expect(find("cafe")).toEqual(["meet at the café at noon"]);
  });

  it("finds deployed and deploying from deploy, as it is typed", () => {
    post("we deployed the release");
    post("deploying the release now");
    expect(find("deploy")).toEqual(["deploying the release now", "we deployed the release"]);
  });

  // English stemming (FTS5's porter) was measured and left out (H06). It
  // finds "deployed" from "deploying", but also "general" from "generous" and
  // "organ" from "organization", and results are listed newest first with
  // nothing to put the exact word ahead of those. It would also apply English
  // endings to every other language written in Latin letters.
  it("does not stem, so a word is not found by an unrelated one that shares its stem", () => {
    post("the general meeting");
    post("we deployed the release");
    expect(find("generous")).toEqual([]);
    expect(find("deploying release")).toEqual([]);
  });
});

describe("the index follows every change to a message", () => {
  it("as it is posted, edited and deleted", () => {
    const id = post("我们明天部署新版本");
    expect(find("部署")).toHaveLength(1);
    store.messages.edit(id, "明日新しいバージョンをデプロイします");
    expect(find("部署")).toEqual([]);
    expect(find("デプロイ")).toEqual(["明日新しいバージョンをデプロイします"]);
    store.messages.delete(id);
    expect(find("デプロイ")).toEqual([]);
  });

  it("when retention removes it", () => {
    post("พรุ่งนี้เราจะปรับใช้เวอร์ชันใหม่");
    expect(find("ปรับใช้")).toHaveLength(1);
    store.messages.purgeBefore(Date.now() + 1000);
    expect(find("ปรับใช้")).toEqual([]);
  });

  it("holds exactly the words of the messages that are there", () => {
    const kept = post("我们明天部署新版本 and the deploy");
    const edited = post("first words 明日");
    const deleted = post("신규버전을 배포합니다");
    store.messages.edit(edited, "second words バージョン");
    store.messages.delete(deleted);
    // FTS5 throws here if its own records disagree with each other.
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages_fts WHERE rowid NOT IN (SELECT rowid FROM messages)",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(find("first")).toEqual([]);
    expect(find("明日")).toEqual([]);
    expect(find("second バージョン")).toEqual(["second words バージョン"]);
    expect(find("배포")).toEqual([]);
    expect(find("部署 deploy")).toEqual([store.messages.get(kept)!.text]);
  });
});
