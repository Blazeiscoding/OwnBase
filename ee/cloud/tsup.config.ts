import { defineConfig } from "tsup";

/**
 * The control plane in one file, dependencies included, to run beside the
 * server bundle (ownbase-server.js) it starts for each workspace.
 */
export default defineConfig({
  entry: { "ownbase-cloud": "src/main.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  noExternal: [/.*/],
  splitting: false,
  external: [/^node:/],
  // node:sqlite exists only under its prefix; tsup would take it off.
  removeNodeProtocol: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // CJS deps bundled into ESM need a real require for node builtins.
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  clean: true,
});
