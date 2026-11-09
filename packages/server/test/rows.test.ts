import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countOf, oneOf, oneOfOrNull, shape } from "../src/core/rows.js";

describe("typed rows", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE t (id TEXT, n INTEGER, kind TEXT, note TEXT, data BLOB);
      INSERT INTO t VALUES ('a', 1, 'dm', NULL, x'0102');
      INSERT INTO t VALUES ('b', 2, 'public', 'hi', NULL);`);
  });
  afterEach(() => db.close());

  const row = shape({
    id: "text",
    n: "number",
    kind: oneOf({ dm: true, public: true }),
    note: "text?",
    data: "bytes?",
  });

  it("reads the named columns, leaving others out", () => {
    const rows = row.pick("id", "note").all(db.prepare("SELECT * FROM t ORDER BY id"));
    expect(rows).toEqual([
      { id: "a", note: null },
      { id: "b", note: "hi" },
    ]);
    const first = row.get(db.prepare("SELECT * FROM t WHERE id = ?"), "a")!;
    expect(first.kind).toBe("dm");
    expect([...first.data!]).toEqual([1, 2]);
    expect(row.get(db.prepare("SELECT * FROM t WHERE id = ?"), "z")).toBeUndefined();
  });

  it("refuses a column that is missing, NULL where it may not be, or of another type", () => {
    expect(() => row.all(db.prepare("SELECT id, n, kind, note FROM t"))).toThrow(/data/);
    expect(() =>
      shape({ note: "text" }).get(db.prepare("SELECT note FROM t WHERE id = 'a'")),
    ).toThrow(/note/);
    expect(() => shape({ id: "number" }).get(db.prepare("SELECT id FROM t"))).toThrow(/id/);
  });

  it("refuses a word outside the set, and NULL unless the set allows it", () => {
    db.exec("UPDATE t SET kind = 'group' WHERE id = 'a'");
    expect(() => row.all(db.prepare("SELECT * FROM t"))).toThrow(/"group"/);
    const kinds = { dm: true, public: true, group: true } as const;
    expect(() => shape({ note: oneOf(kinds) }).get(db.prepare("SELECT note FROM t"))).toThrow();
    expect(
      shape({ note: oneOfOrNull({ hi: true }) }).all(db.prepare("SELECT note FROM t ORDER BY id")),
    ).toEqual([{ note: null }, { note: "hi" }]);
  });

  it("counts with countOf, and adds columns with `with`", () => {
    expect(countOf(db.prepare("SELECT COUNT(*) AS n FROM t WHERE n > ?"), 1)).toBe(1);
    const wider = row.pick("id").with({ doubled: "number" });
    expect(wider.all(db.prepare("SELECT id, n * 2 AS doubled FROM t ORDER BY id"))).toEqual([
      { id: "a", doubled: 2 },
      { id: "b", doubled: 4 },
    ]);
  });
});
