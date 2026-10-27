import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEEP_LINK_PROTOCOL } from "@ownbase/protocol";

/**
 * The desktop app installs as OwnBase and opens ownbase:// links, and no
 * other scheme (P2b). Words elsewhere are scripts/check-product-name.mjs's.
 */
describe("the desktop app's name", () => {
  it("is installed under OwnBase, opening ownbase:// links", () => {
    const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    expect(builder).toMatch(/^productName: OwnBase$/m);
    expect(builder).toMatch(/^appId: dev\.ownbase\.desktop$/m);
    // Names the Windows install folder, Programs\OwnBase.
    expect(builder).toMatch(/^extraMetadata:\n {2}name: OwnBase$/m);
    const schemes = builder
      .slice(builder.indexOf("schemes:"))
      .split("\n")
      .slice(1)
      .map((line) => /^\s+- (\S+)$/.exec(line)?.[1])
      .filter((scheme): scheme is string => !!scheme);
    expect(schemes).toEqual([DEEP_LINK_PROTOCOL]);
    expect(schemes).toEqual(["ownbase"]);
  });
});
