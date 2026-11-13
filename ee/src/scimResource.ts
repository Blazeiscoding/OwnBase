/**
 * SCIM 2.0's own language (RFC 7643 and 7644), as far as Okta and Microsoft
 * Entra ID speak it to a User endpoint: filters such as `userName eq "x"`,
 * and PATCH operations on paths such as `emails[type eq "work"].value`. No
 * server here: what a resource holds, what a filter picks and what a patch
 * changes.
 */

export const CORE_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const ENTERPRISE_USER = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** A refusal in SCIM's shape: its status, and for a 400 or 409 what kind of problem. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?:
      | "invalidFilter"
      | "invalidPath"
      | "invalidSyntax"
      | "invalidValue"
      | "mutability"
      | "noTarget"
      | "uniqueness",
  ) {
    super(message);
  }

  body() {
    return {
      schemas: [ERROR_SCHEMA],
      status: String(this.status),
      ...(this.scimType ? { scimType: this.scimType } : {}),
      detail: this.message,
    };
  }
}

/** A resource's attributes, as the provider sent them. */
export type Attributes = Record<string, unknown>;

/** Attributes that hold a list, so an `add` adds to them. */
const MULTI_VALUED = new Set([
  "emails",
  "phonenumbers",
  "ims",
  "photos",
  "addresses",
  "groups",
  "entitlements",
  "roles",
  "x509certificates",
]);

/** Compared as written; every other text is compared without regard to case (RFC 7643 2.2). */
const CASE_EXACT = new Set(["id", "externalid"]);

const isObject = (value: unknown): value is Attributes =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The attribute named `name` in `on`, found without regard to case, as SCIM names are. */
function keyIn(on: Attributes, name: string): string {
  const lower = name.toLowerCase();
  return Object.keys(on).find((key) => key.toLowerCase() === lower) ?? name;
}

// ---------------------------------------------------------------- paths

/** `emails[type eq "work"].value` as its parts, with any schema's prefix taken off. */
interface Path {
  /** Where it is: the resource itself, or the enterprise extension's object in it. */
  extension: boolean;
  attribute: string;
  filter?: Filter;
  sub?: string;
}

function parsePath(text: string): Path {
  let rest = text.trim();
  let extension = false;
  for (const urn of [CORE_USER, ENTERPRISE_USER]) {
    if (rest.toLowerCase().startsWith(`${urn.toLowerCase()}:`)) {
      rest = rest.slice(urn.length + 1);
      extension = urn === ENTERPRISE_USER;
    }
  }
  const match = /^([A-Za-z][\w$-]*)(?:\[(.*)\])?(?:\.([A-Za-z][\w$-]*))?$/s.exec(rest);
  if (!match)
    throw new ScimError(400, `"${text}" is not a path this server understands.`, "invalidPath");
  return {
    extension,
    attribute: match[1]!,
    ...(match[2] !== undefined ? { filter: parseFilter(match[2]) } : {}),
    ...(match[3] !== undefined ? { sub: match[3] } : {}),
  };
}

// ---------------------------------------------------------------- filters

/** Comparisons joined by `and`, the only joining Okta and Entra send. */
export type Filter = { path: string; op: "eq" | "pr"; value?: unknown }[];

/** Reads a filter such as `userName eq "maya@acme.com" and active eq true`. */
export function parseFilter(text: string): Filter {
  const filter: Filter = [];
  let rest = text.trim();
  for (;;) {
    const match =
      /^([A-Za-z][\w$:.-]*(?:\[[^\]]*\])?(?:\.[A-Za-z][\w$-]*)?)\s+(eq|pr)\b\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?)?\s*/i.exec(
        rest,
      );
    if (!match)
      throw new ScimError(
        400,
        `This server understands filters such as userName eq "someone", joined by and. It could not read: ${text}`,
        "invalidFilter",
      );
    const op = match[2]!.toLowerCase() as "eq" | "pr";
    if ((op === "eq") !== (match[3] !== undefined))
      throw new ScimError(400, `Could not read the filter ${text}`, "invalidFilter");
    filter.push({
      path: match[1]!,
      op,
      ...(match[3] !== undefined ? { value: JSON.parse(match[3]) as unknown } : {}),
    });
    rest = rest.slice(match[0].length);
    if (!rest) return filter;
    const and = /^and\s+/i.exec(rest);
    if (!and)
      throw new ScimError(
        400,
        `This server joins comparisons with and alone. It could not read: ${text}`,
        "invalidFilter",
      );
    rest = rest.slice(and[0].length);
  }
}

/** Every value at `path` in `on`, through lists and the filters in brackets. */
function valuesAt(on: Attributes, text: string): unknown[] {
  const path = parsePath(text);
  const holder = path.extension ? on[keyIn(on, ENTERPRISE_USER)] : on;
  if (!isObject(holder)) return [];
  let values: unknown[] = [holder[keyIn(holder, path.attribute)]].flat();
  if (path.filter) values = values.filter((v) => isObject(v) && matches(v, path.filter!));
  if (path.sub)
    values = values.flatMap((v) => (isObject(v) ? [v[keyIn(v, path.sub!)]] : [])).flat();
  return values.filter((v) => v !== undefined && v !== null);
}

function same(attribute: string, a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string")
    return CASE_EXACT.has(attribute.toLowerCase()) ? a === b : a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Whether `on` passes every comparison in `filter`. */
export function matches(on: Attributes, filter: Filter): boolean {
  return filter.every(({ path, op, value }) => {
    const found = valuesAt(on, path);
    if (op === "pr") return found.some((v) => v !== "" && !(Array.isArray(v) && !v.length));
    const last = path
      .replace(/\[.*\]/s, "")
      .split(/[.:]/)
      .at(-1)!;
    return found.some((v) => same(last, v, value));
  });
}

// ---------------------------------------------------------------- patches

/** What a filter in a path says an element has, for one made because none matched. */
function filterFields(filter: Filter): Attributes {
  return Object.fromEntries(
    filter.filter((f) => f.op === "eq" && !/[.[:]/.test(f.path)).map((f) => [f.path, f.value]),
  );
}

/**
 * A single value Entra sends as a one-element list, `[{ "value": x }]`, for
 * an attribute that holds one.
 */
function unwrap(attribute: string, value: unknown): unknown {
  if (
    !MULTI_VALUED.has(attribute.toLowerCase()) &&
    Array.isArray(value) &&
    value.length === 1 &&
    isObject(value[0]) &&
    Object.keys(value[0]).length === 1 &&
    "value" in value[0]
  )
    return value[0].value;
  return value;
}

/** "True" as Entra sent it before 2020, as the boolean it means. */
function coerce(attribute: string, value: unknown): unknown {
  if (attribute.toLowerCase() === "active" && typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return value;
}

type Op = "add" | "replace" | "remove";

function applyAt(resource: Attributes, op: Op, pathText: string, raw: unknown): void {
  const path = parsePath(pathText);
  let holder = resource;
  if (path.extension) {
    const key = keyIn(resource, ENTERPRISE_USER);
    if (!isObject(resource[key])) {
      if (op === "remove") return;
      resource[key] = {};
    }
    holder = resource[key] as Attributes;
  }
  const key = keyIn(holder, path.attribute);
  const value = coerce(path.sub ?? path.attribute, unwrap(path.sub ?? path.attribute, raw));

  if (path.filter) {
    const list = Array.isArray(holder[key]) ? (holder[key] as unknown[]) : [];
    const hit = (v: unknown) => isObject(v) && matches(v, path.filter!);
    if (op === "remove") {
      if (path.sub)
        for (const v of list)
          if (hit(v)) delete (v as Attributes)[keyIn(v as Attributes, path.sub)];
      holder[key] = list.filter((v) => !hit(v) || path.sub);
      return;
    }
    const found = list.filter(hit) as Attributes[];
    // Entra replaces a work address nobody has yet: it means add one.
    if (!found.length) {
      const made = {
        ...filterFields(path.filter),
        ...(path.sub ? { [path.sub]: value } : isObject(value) ? value : {}),
      };
      holder[key] = [...list, made];
      return;
    }
    for (const v of found) {
      if (path.sub) v[keyIn(v, path.sub)] = value;
      else if (isObject(value)) Object.assign(v, value);
    }
    return;
  }

  if (path.sub) {
    if (op === "remove") {
      if (isObject(holder[key]))
        delete (holder[key] as Attributes)[keyIn(holder[key] as Attributes, path.sub)];
      return;
    }
    if (!isObject(holder[key])) holder[key] = {};
    const inner = holder[key] as Attributes;
    inner[keyIn(inner, path.sub)] = value;
    return;
  }

  if (op === "remove") {
    delete holder[key];
    return;
  }
  if (op === "add" && Array.isArray(holder[key]) && Array.isArray(value)) {
    const list = holder[key] as unknown[];
    const fresh = value.filter((v) => !list.some((w) => JSON.stringify(w) === JSON.stringify(v)));
    holder[key] = [...list, ...fresh];
    return;
  }
  if (op === "add" && isObject(holder[key]) && isObject(value)) {
    Object.assign(holder[key] as Attributes, value);
    return;
  }
  holder[key] = value;
}

/**
 * The resource with a PATCH request's operations made on it (RFC 7644
 * 3.5.2), as a new object. `op` is read without regard to case, since Entra
 * sends "Replace".
 */
export function applyPatch(resource: Attributes, request: unknown): Attributes {
  if (!isObject(request) || !Array.isArray(request[keyIn(request, "Operations")]))
    throw new ScimError(400, "A PATCH needs its Operations.", "invalidSyntax");
  const next = structuredClone(resource);
  for (const operation of request[keyIn(request, "Operations")] as unknown[]) {
    if (!isObject(operation))
      throw new ScimError(400, "Each operation is an object.", "invalidSyntax");
    const op = String(operation[keyIn(operation, "op")] ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove")
      throw new ScimError(
        400,
        `"${String(operation.op)}" is not add, replace or remove.`,
        "invalidSyntax",
      );
    const path = operation[keyIn(operation, "path")];
    const value = operation[keyIn(operation, "value")];
    if (typeof path === "string" && path) {
      applyAt(next, op, path, value);
      continue;
    }
    if (op === "remove") throw new ScimError(400, "A remove needs a path.", "noTarget");
    if (!isObject(value))
      throw new ScimError(
        400,
        "An operation with no path needs an object of attributes.",
        "invalidSyntax",
      );
    // Okta sends `{ "op": "replace", "value": { "active": false } }`; a key
    // may itself be a path, such as "name.givenName".
    for (const [name, attribute] of Object.entries(value)) applyAt(next, op, name, attribute);
  }
  return next;
}

/** A resource's attribute, found without regard to case. */
export function attribute(on: Attributes, name: string): unknown {
  return on[keyIn(on, name)];
}
