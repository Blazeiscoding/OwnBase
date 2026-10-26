import { writeFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { ARTIFACTS, buildIdentity } from "../../scripts/build-identity.mjs";

// Which source this build is (IMP-08): the server reports it, and
// dist/build.json lets tests refuse a bundle older than the checkout.
const identity = buildIdentity(ARTIFACTS.server.inputs);

/** Bundle the whole server (deps included) into one runnable file — zero-install deploys. */
export default defineConfig({
  entry: { "slackoss-server": "../../packages/server/src/main.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  noExternal: [/.*/],
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
