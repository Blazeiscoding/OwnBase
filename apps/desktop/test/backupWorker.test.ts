import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The backup worker takes the server package's backup entry, never its
 * barrel (REV-07): the barrel brings Fastify, sockets and discovery into a
 * job that copies, checks or restores a database.
 */
describe("the backup worker", () => {
  it("imports only the backup entry of the server package", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/main/backupWorker.ts"),
      "utf8",
    );
    const workspaceImports = [...source.matchAll(/from\s+"(@ownbase\/[^"]+)"/g)].map((m) => m[1]);
    expect(workspaceImports).toEqual(["@ownbase/server/backup"]);
  });
});
