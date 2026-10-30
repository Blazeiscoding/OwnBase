import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_EVENT_TYPES, APP_SCOPES, eventScopes, type WorkspaceEvent } from "@ownbase/protocol";
import { INPUT_ELEMENTS } from "../src/blockKit.js";
import { signatureHeaders, toSlackEvent } from "../src/integrations.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * docs/INTEGRATIONS.md is a promise to people writing apps. The parts of it that
 * can drift silently — which methods exist, what each event becomes, and the
 * example they are told to copy — are read from the document itself here and
 * held against the code, so a change to either side that leaves them
 * disagreeing fails rather than ships.
 */

const here = dirname(fileURLToPath(import.meta.url));
// Line endings normalised, so a file an editor saved with CRLF is read the same.
const read = (path: string) => readFileSync(resolve(here, path), "utf8").replace(/\r\n/g, "\n");
const doc = read("../../../docs/INTEGRATIONS.md");

/** The rows of the first table after a line containing `heading`. */
function tableAfter(heading: string): string[][] {
  const start = doc.indexOf(heading);
  expect(start, `INTEGRATIONS.md has no "${heading}"`).toBeGreaterThanOrEqual(0);
  const lines = doc.slice(start).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    // The header and the dashes under it.
    if (cells[0]!.startsWith("-") || !cells[0]!.startsWith("`")) continue;
    rows.push(cells.map((cell) => cell.replace(/^`|`$/g, "")));
  }
  return rows;
}

describe("the Web API methods the document lists", () => {
  const documented = tableAfter("The supported methods").map(([method]) => method!);

  it("are exactly the ones the server implements", () => {
    const source = read("../src/server.ts");
    const implemented = [...source.matchAll(/app\.post\("\/api\/([a-z]+(?:\.[A-Za-z]+)+)"/g)].map(
      (m) => m[1]!,
    );
    expect(documented.length).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...new Set(implemented)].sort());
  });

  describe("against a running server", () => {
    let server: WorkspaceServer;
    let base: string;

    beforeAll(async () => {
      server = await createWorkspaceServer({
        dataDir: ":memory:",
        host: "127.0.0.1",
        port: 0,
        mdns: false,
        logger: false,
      });
      base = `http://127.0.0.1:${server.port}`;
    });
    afterAll(() => server.stop());

    const post = async (path: string) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
    };

    it("answers each one, in Slack's shape, rather than as unknown", async () => {
      for (const method of documented) {
        // No token: an implemented method refuses the caller, not the method.
        expect(await post(`/api/${method}`), method).toEqual({
          status: 200,
          body: { ok: false, error: "invalid_auth" },
        });
      }
    });

    it("names any other Slack method as unknown", async () => {
      for (const method of ["chat.update", "conversations.list", "apps.connections.open"]) {
        expect(await post(`/api/${method}`), method).toEqual({
          status: 200,
          body: { ok: false, error: "unknown_method" },
        });
      }
    });

    it("leaves the native API's own not-found alone", async () => {
      expect(await post("/api/no-such-route")).toEqual({
        status: 404,
        body: { error: "not_found" },
      });
    });
  });
});

describe("the event table", () => {
  const rows = tableAfter("The events");
  const documented = new Map(rows.map(([native, slack]) => [native!, slack!] as const));

  /** One event carrying every field any event type reads. */
  const sample = (type: string) =>
    ({
      type,
      message: {
        id: "M1",
        channelId: "C1",
        userId: "U1",
        text: "hi",
        threadRootId: null,
        files: [],
        actions: [],
      },
      channel: { id: "C1", name: "general", createdAt: 0, creatorId: "U1" },
      user: { id: "U1", handle: "alice", displayName: "Alice", isBot: false, deactivated: false },
      channelId: "C1",
      messageId: "M1",
      threadRootId: null,
      userId: "U1",
      emoji: "👍",
    }) as unknown as WorkspaceEvent;

  it("says what each event becomes", () => {
    expect(documented.size).toBeGreaterThan(0);
    for (const [native, slack] of documented) {
      expect(toSlackEvent(sample(native))?.type, native).toBe(slack);
    }
  });

  it("leaves out no event an app can receive", () => {
    // Every durable event type, read from the protocol so a new one cannot be
    // added without this noticing whether apps are sent it.
    const protocol = read("../../protocol/src/events.ts").split("\n");
    const start = protocol.findIndex((line) => line.startsWith("export type WorkspaceEvent ="));
    expect(start, "no WorkspaceEvent union in the protocol").toBeGreaterThanOrEqual(0);
    // The union's members are the `|` lines that follow; the first line that is
    // not one ends it. Semicolons inside the members make a character search
    // stop too early.
    const members: string[] = [];
    for (const line of protocol.slice(start + 1)) {
      if (!line.trimStart().startsWith("|")) break;
      members.push(line);
    }
    const types = members.map((line) => /type: "([a-z]+\.[a-z]+)"/.exec(line)![1]!);
    expect(types.length).toBeGreaterThan(0);
    const delivered = types.filter((type) => toSlackEvent(sample(type)) !== null);
    expect([...documented.keys()].sort()).toEqual(delivered.sort());
    // The list the Apps dialog reasons about scopes from, too.
    expect([...APP_EVENT_TYPES].sort()).toEqual(delivered.sort());
  });

  it("names the scopes an app needs to be sent each one", () => {
    for (const [native, , , scopes] of rows) {
      const named = scopes!.split(/[`,\s]+/).filter(Boolean);
      expect(named, native).toEqual(eventScopes(native!));
    }
  });
});

describe("the scope table", () => {
  it("lists exactly the scopes an app can be given, in order", () => {
    expect(tableAfter("The scopes").map(([scope]) => scope)).toEqual([...APP_SCOPES]);
  });
});

describe("the modal input table", () => {
  it("lists exactly the elements a view can hold, and where each answer goes", () => {
    const documented = tableAfter("The input elements");
    expect(documented.length).toBeGreaterThan(0);
    // The answer column starts with the key, sometimes followed by its format.
    const said = Object.fromEntries(
      documented.map(([element, , answer]) => [element!, answer!.split("`")[0]!]),
    );
    const drawn = Object.fromEntries(
      Object.entries(INPUT_ELEMENTS).map(([element, { key }]) => [element, key]),
    );
    expect(said).toEqual(drawn);
  });
});

describe("the signature example", () => {
  let verify: (
    secret: string,
    headers: Record<string, string>,
    body: string,
    now?: number,
  ) => boolean;
  let dir: string;

  beforeAll(async () => {
    const marker = doc.indexOf("<!-- checked: verify-signature -->");
    expect(marker, "INTEGRATIONS.md has no checked signature example").toBeGreaterThanOrEqual(0);
    const code = /```js\n([\s\S]*?)```/.exec(doc.slice(marker))![1]!;
    // Run exactly what the document tells people to copy.
    dir = mkdtempSync(join(tmpdir(), "ownbase-contract-"));
    const file = join(dir, "verify.mjs");
    writeFileSync(file, code);
    ({ verifySlackRequest: verify } = (await import(pathToFileURL(file).href)) as {
      verifySlackRequest: typeof verify;
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Deliberately low-entropy: a made-up key that no scanner should mistake for a real one.
  const secret = "test-signing-secret-not-a-credential";
  const body = "command=%2Fdeploy&text=staging";
  const now = 1_789_291_228_000;

  it("accepts a request signed the way this server signs", () => {
    expect(verify(secret, signatureHeaders(secret, body, now), body, now)).toBe(true);
  });

  it("refuses a body that was changed after signing", () => {
    const headers = signatureHeaders(secret, body, now);
    expect(verify(secret, headers, body.replace("staging", "production"), now)).toBe(false);
  });

  it("refuses a request signed with another secret", () => {
    expect(verify(secret, signatureHeaders("another-secret", body, now), body, now)).toBe(false);
  });

  it("refuses a request replayed ten minutes later", () => {
    const headers = signatureHeaders(secret, body, now);
    expect(verify(secret, headers, body, now + 10 * 60_000)).toBe(false);
  });
});
