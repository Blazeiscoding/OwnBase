import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapiDocument.js";

/**
 * packages/server/openapi.json describes the native REST API (E18). This
 * builds it again from the endpoint table and fails when the checked-in file differs,
 * so CI catches a route or schema changed without it. Rewrite the file with
 * `pnpm --filter @ownbase/server exec vitest run test/openapi.test.ts -u`.
 */

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

  it("takes each body and query from the schema the route is validated with", () => {
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
