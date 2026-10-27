import { writeFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { ARTIFACTS, buildIdentity } from "../../scripts/build-identity.mjs";

// Which source this build is (IMP-08): the server reports it, and
// dist/build.json lets tests refuse a bundle older than the checkout.
const identity = buildIdentity(ARTIFACTS.server.inputs);

/**
 * Bundle the whole server (deps included) into one runnable file — zero-install
 * deploys. Built from ee/'s entry (P6), so the file carries the Enterprise
 * edition too; without a license it runs as the free one.
 */
export default defineConfig({
  entry: { "ownbase-server": "../../ee/src/main.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  noExternal: [/.*/],
  // One file: ee/src/main.ts imports the server's main.ts dynamically, which
  // would otherwise become a second file beside it.
  splitting: false,
  external: [/^node:/],
  banner: {
    js: [
      "#!/usr/bin/env node",
      // CJS deps bundled into ESM need a real require for node builtins.
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __OWNBASE_BUILD__: JSON.stringify(identity) },
  clean: true,
  async onSuccess() {
    writeFileSync("dist/build.json", JSON.stringify(identity, null, 2) + "\n");
  },
});
