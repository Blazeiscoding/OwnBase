import { describe, expect, it } from "vitest";
import { createWorkspaceServer } from "../src/server.js";
import { openApiDocument, sourceRoutes } from "./openapiDocument.js";

/**
 * packages/server/openapi.json describes the native REST API (E18). This
 * builds it again from the source and fails when the checked-in file differs,
 * so CI catches a route or schema changed without it. Rewrite the file with
 * `pnpm --filter @ownbase/server exec vitest run test/openapi.test.ts -u`.
 */

/** Fastify's route tree flattened to `METHOD /path`, leaving out HEAD. */
function flatten(tree: string): string[] {
  const above: string[] = [];
  const routes: string[] = [];
  for (const line of tree.split("\n")) {
    const node = /^((?:│ {3}| {4})*)(?:├── |└── )(\S+)(?: \(([^)]*)\))?$/.exec(line);
    if (!node) continue;
    const depth = node[1]!.length / 4;
    above.length = depth;
    const path = (above[depth - 1] ?? "") + node[2]!;
    above[depth] = path;
    for (const method of (node[3] ?? "").split(", ").filter(Boolean)) {
      if (method !== "HEAD") routes.push(`${method} ${path}`);
    }
  }
  return routes;
}

/** Every route a running server answers under /api/, from Fastify's own table. */
async function registeredRoutes(): Promise<string[]> {
  let tree = "";
  const server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    // An extension is handed the server before it listens, and reads the
    // table once it is ready: a few routes come after the extensions.
    extensions: [
      {
        name: "route-list",
        register(context) {
          context.app.addHook("onReady", async () => {
            tree = context.app.printRoutes({ commonPrefix: false });
          });
        },
      },
    ],
  });
  await server.stop();
  return flatten(tree).filter((route) => route.split(" ")[1]!.startsWith("/api/"));
}

describe("the OpenAPI description of the REST API (E18)", () => {
  const document = openApiDocument();
  const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      path,
      method,
      operation: operation as {
        operationId: string;
        parameters?: { name: string; in: string }[];
        requestBody?: { content: Record<string, { schema: { $ref?: string } }> };
        security: unknown[];
      },
    })),
  );

  it("describes every route the server answers, and no other", async () => {
    const described = sourceRoutes().map((route) => `${route.method.toUpperCase()} ${route.path}`);
    expect(described.length).toBeGreaterThan(100);
    const registered = await registeredRoutes();
    expect(described.filter((route) => !registered.includes(route))).toEqual([]);
    // A route added some way the description does not read would land here.
    expect(registered.filter((route) => !described.includes(route))).toEqual([]);
  });

  it("names each path parameter, and every reference leads somewhere", () => {
    for (const { path, method, operation } of operations) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
      const declared = (operation.parameters ?? []).filter((p) => p.in === "path");
      expect(
        declared.map((p) => p.name),
        `${method} ${path}`,
      ).toEqual(inPath);
    }
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(0);
    const components = document.components as unknown as Record<string, Record<string, unknown>>;
    for (const [, kind, name] of refs)
      expect(components[kind!]?.[name!], `${kind}/${name}`).toBeDefined();
  });

  it("names each operation once, and says what each group is for", () => {
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("chat.postMessage");
    expect(ids).toContain("getChannelsByIdMessages");
    // A route under a new first segment needs a line in TAG_WORDS.
    expect(document.tags.filter((tag) => !tag.description).map((tag) => tag.name)).toEqual([]);
  });

  it("takes each body and query from the schema the route validates with", () => {
    const operation = (method: string, path: string) =>
      operations.find((o) => o.method === method && o.path === path)!.operation;
    expect(
      operation("post", "/api/channels").requestBody!.content["application/json"]!.schema,
    ).toEqual({
      $ref: "#/components/schemas/CreateChannelBody",
    });
    expect(
      operation("get", "/api/channels/{id}/messages").parameters!.map((p) => `${p.in}:${p.name}`),
    ).toEqual(["path:id", "query:before", "query:limit", "query:threadRootId"]);
    expect(operation("post", "/api/chat.postMessage").security).toEqual([{ botToken: [] }]);
    expect(operation("put", "/api/apps/{id}/scopes").security).toEqual([{ session: [] }]);
    expect(operation("get", "/api/health").security).toEqual([]);
  });

  it("is the file in the repository", async () => {
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot("../openapi.json");
  });
});
