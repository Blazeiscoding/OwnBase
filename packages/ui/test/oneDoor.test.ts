import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The UI reaches the workspace through WorkspaceClient's own methods, so
 * whatever a change means for the store, the client hears it (U6). A raw
 * REST call, or a write straight into the client's store, goes round it.
 */
const SRC = join(__dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

function offending(pattern: RegExp): string[] {
  return sources(SRC).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, at) =>
        pattern.test(line) ? [`${relative(SRC, file)}:${at + 1}: ${line.trim()}`] : [],
      ),
  );
}

describe("the UI's way to the workspace", () => {
  it("never calls a connected client's raw REST API", () => {
    expect(offending(/\b(client|clientFromCtx)\s*\.api\b/)).toEqual([]);
  });

  it("never writes a connected client's store", () => {
    expect(offending(/\.store\.setState\(/)).toEqual([]);
  });
});
