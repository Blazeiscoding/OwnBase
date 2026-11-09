import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A backup job loads the backup module and what it needs, not the server
 * (REV-07). Fastify, sockets and discovery cost a backup worker about half
 * its start-up time and memory, and it uses none of them.
 */
const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Every module `entry` loads, following relative imports, and the packages they name. */
function graph(entry: string): { modules: string[]; packages: string[] } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (modules.has(file)) return;
    modules.add(file);
    const source = readFileSync(join(src, file), "utf8");
    for (const [, specifier] of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s(?![^;]*\btype\s*\{)[^;]*?from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g,
    )) {
      if (!specifier) continue;
      if (specifier.startsWith("."))
        visit(posix.join(posix.dirname(file), specifier).replace(/\.js$/, ".ts"));
      else if (!specifier.startsWith("node:")) packages.add(specifier);
    }
  };
  visit(entry);
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

describe("what a backup job loads", () => {
  it("is the backup module, the schema and the ownership lock, with zod", () => {
    expect(graph("backup.ts")).toEqual({
      modules: ["backup.ts", "db.ts", "ownership.ts", "version.ts"],
      packages: ["zod"],
    });
  });

  it("is not the server, whose graph does load the networking packages", () => {
    // The check above would pass vacuously if the scanner missed imports.
    const server = graph("server.ts");
    expect(server.modules).toContain("version.ts");
    for (const name of ["fastify", "@fastify/cors", "@fastify/static", "ws"])
      expect(server.packages).toContain(name);
    expect(graph("mdns.ts").packages).toContain("bonjour-service");
  });

  it("is published on its own entry, for the desktop app's worker", async () => {
    const manifest = JSON.parse(readFileSync(join(src, "../package.json"), "utf8"));
    expect(manifest.exports["./backup"]).toBe("./src/backup.ts");
    const backup = await import("../src/backup.js");
    for (const name of ["backupWorkspace", "verifyBackup", "inventoryBackup", "restoreWorkspace"])
      expect(typeof backup[name as keyof typeof backup]).toBe("function");
  });
});
