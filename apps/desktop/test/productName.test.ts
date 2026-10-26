import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEEP_LINK_PROTOCOLS } from "@slackoss/protocol";

/**
 * The desktop app's own words name it OwnBase (P2). Its main process is built
 * with comments kept, so this reads the sources: every string in them, not
 * the comments that say where an earlier name is kept and why.
 */
const src = fileURLToPath(new URL("../src/", import.meta.url));
const STRING = /(["'`])((?:\\.|(?!\1).)*)\1/g;
/** Earlier names in code that finds what those versions left behind. */
const KEPT = new Set(["Tandem.exe", "Gatherline.exe"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|html)$/.test(entry.name) ? [path] : [];
  });
}

describe("the desktop app's name", () => {
  it("is OwnBase in every string it shows or sends", () => {
    const found: string[] = [];
    for (const file of sources(src)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\/?\*)/.test(line)) return;
          for (const [, , text] of line.matchAll(STRING)) {
            if (/\b(Tandem|Gatherline)\b/.test(text!) && !KEPT.has(text!))
              found.push(`${file.slice(src.length)}:${i + 1}: ${text}`);
          }
        });
    }
    expect(found).toEqual([]);
  });

  it("is installed under OwnBase, with every link scheme the app reads, earlier names too", () => {
    const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    expect(builder).toMatch(/^productName: OwnBase$/m);
    const schemes = builder
      .slice(builder.indexOf("schemes:"))
      .split("\n")
      .slice(1)
      .map((line) => /^\s+- (\S+)$/.exec(line)?.[1])
      .filter((scheme): scheme is string => !!scheme);
    expect(schemes).toEqual([...DEEP_LINK_PROTOCOLS]);
    expect(schemes).toEqual(["ownbase", "tandem", "gatherline", "slackoss"]);
  });
});
