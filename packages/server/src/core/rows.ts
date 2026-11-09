import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

/**
 * What one column reads back as: text, a number or bytes, and `?` when the
 * schema lets it be NULL. node:sqlite hands back untyped records; a shape
 * checks each named column once, so a query whose columns drift from what
 * its reader expects fails at that read instead of passing a wrong value on.
 */
export type Column = "text" | "text?" | "number" | "number?" | "bytes" | "bytes?";

type ValueOf<C extends Column> = C extends "text"
  ? string
  : C extends "text?"
    ? string | null
    : C extends "number"
      ? number
      : C extends "number?"
        ? number | null
        : C extends "bytes"
          ? Uint8Array
          : Uint8Array | null;

export type Columns = Readonly<Record<string, Column>>;

export type RowOf<S extends Columns> = { -readonly [K in keyof S]: ValueOf<S[K]> };

export interface Shape<S extends Columns> {
  readonly columns: S;
  /** The named columns of one raw row, checked; other columns are left out. */
  read(raw: Record<string, SQLOutputValue>): RowOf<S>;
  get(statement: StatementSync, ...params: SQLInputValue[]): RowOf<S> | undefined;
  all(statement: StatementSync, ...params: SQLInputValue[]): RowOf<S>[];
  /** This shape plus more columns, for a query that joins or computes extra. */
  with<T extends Columns>(more: T): Shape<S & T>;
  /** Some of this shape's columns, for a query that reads only those. */
  pick<K extends keyof S & string>(...names: K[]): Shape<Pick<S, K>>;
}

function fits(value: SQLOutputValue | undefined, column: Column): boolean {
  if (value === null) return column.endsWith("?");
  switch (column) {
    case "text":
    case "text?":
      return typeof value === "string";
    case "number":
    case "number?":
      return typeof value === "number";
    case "bytes":
    case "bytes?":
      return value instanceof Uint8Array;
  }
}

export function shape<S extends Columns>(columns: S): Shape<S> {
  const entries = Object.entries(columns);
  const read = (raw: Record<string, SQLOutputValue>): RowOf<S> => {
    const row: Record<string, SQLOutputValue> = {};
    for (const [name, column] of entries) {
      const value = raw[name];
      if (!fits(value, column))
        throw new Error(
          `Column ${name} read ${value === undefined ? "nothing" : typeof value}, expected ${column}`,
        );
      row[name] = value!;
    }
    // Every column of S was checked just above.
    return row as RowOf<S>;
  };
  return {
    columns,
    read,
    get(statement, ...params) {
      const raw = statement.get(...params);
      return raw ? read(raw) : undefined;
    },
    all(statement, ...params) {
      return statement.all(...params).map(read);
    },
    with(more) {
      return shape({ ...columns, ...more });
    },
    pick(...names) {
      const picked: Partial<Record<string, Column>> = {};
      for (const name of names) picked[name] = columns[name];
      return shape(picked as Pick<S, (typeof names)[number]>);
    },
  };
}

const counted = shape({ n: "number" });

/** The one number a `SELECT COUNT(*) AS n …` (or any `… AS n`) reads. */
export function countOf(statement: StatementSync, ...params: SQLInputValue[]): number {
  return counted.get(statement, ...params)!.n;
}
