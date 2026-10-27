import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The MIT code never depends on ee/ (P6): the core is whole without it, and
 * ee/ plugs in through the server's extension point. Only the server bundle's
 * build, which is where the two are put together, names it.
 */
const repo = fileURLToPath(new URL("../../", import.meta.url));
/** Where the two editions are put together, and nowhere else. */
const COMPOSED = new Set(["apps/server-cli/package.json", "apps/server-cli/tsup.config.ts"]);
const SKIP = new Set(["node_modules", "dist", "out", "release", ".turbo", "__screenshots__"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx|mts|mjs|js|json)$/.test(entry.name) ? [path] : [];
  });
}

describe("the line between the MIT core and ee/", () => {
  it("is crossed only where the server bundle is built", () => {
    const crossing: string[] = [];
    for (const top of ["packages", "apps", "scripts", "tests"]) {
      for (const file of files(join(repo, top))) {
        const name = relative(repo, file).replaceAll("\\", "/");
        if (COMPOSED.has(name)) continue;
        const text = readFileSync(file, "utf8");
        if (/@slackoss\/ee\b|["'`](?:\.\.\/)+ee\//.test(text)) crossing.push(name);
      }
    }
    expect(crossing).toEqual([]);
  });

  it("is where the bundle is built from", () => {
    const tsup = readFileSync(join(repo, "apps/server-cli/tsup.config.ts"), "utf8");
    expect(tsup).toContain('"slackoss-server": "../../ee/src/main.ts"');
  });
});
