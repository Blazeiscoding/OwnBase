import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

/**
 * What one column reads back as: text, a number or bytes, and `?` when the
 * schema lets it be NULL. node:sqlite hands back untyped records; a shape
 * checks each named column once, so a query whose columns drift from what
 * its reader expects fails at that read instead of passing a wrong value on.
 */
export type Column =
  "text" | "text?" | "number" | "number?" | "bytes" | "bytes?" | Words<string, boolean>;

/** A text column that holds one of a fixed set of words; see `oneOf`. */
export interface Words<V extends string, Nullable extends boolean = false> {
  readonly words: Readonly<Record<V, true>>;
  readonly nullable: Nullable;
}

/**
 * A column holding one of these words, given as an object keyed by every
 * word, so `satisfies Record<Union, true>` makes the list match its type
 * exactly: a word left out or added fails to compile.
 */
export function oneOf<V extends string>(words: Readonly<Record<V, true>>): Words<V> {
  return { words, nullable: false };
}

/** `oneOf`, or NULL. */
export function oneOfOrNull<V extends string>(words: Readonly<Record<V, true>>): Words<V, true> {
  return { words, nullable: true };
}

type ValueOf<C extends Column> =
  C extends Words<infer V, infer Nullable>
    ? V | (Nullable extends true ? null : never)
    : C extends "text"
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
  if (typeof column === "object")
    return value === null
      ? column.nullable
      : typeof value === "string" && Object.hasOwn(column.words, value);
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
          `Column ${name} read ${value === undefined ? "nothing" : typeof value === "string" ? JSON.stringify(value) : typeof value}, expected ${typeof column === "object" ? Object.keys(column.words).join("|") : column}`,
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
