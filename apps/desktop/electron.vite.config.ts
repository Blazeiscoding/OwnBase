import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ARTIFACTS, buildIdentity } from "../../scripts/build-identity.mjs";

// Which source this build is (IMP-08): the hosted server and the window both
// report it, and out/build.json goes into the package for tests to check.
const identity = buildIdentity(ARTIFACTS.desktop.inputs);
const define = {
  __OWNBASE_BUILD__: JSON.stringify(identity),
  // The Release workflow names the version it builds (scripts/build-identity.mjs);
  // only such a build looks for new versions of itself.
  __OWNBASE_RELEASE__: JSON.stringify(!!process.env.OWNBASE_VERSION),
};

// As in apps/web/vite.config.ts: Rolldown would otherwise put each module the
// first screen shares with a lazy chunk into a file of its own (38 of them),
// where Rollup kept them in the entry.
const FIRST_PAINT_IN_ONE_FILE = { groups: [{ name: "index", tags: ["$initial" as const] }] };

export default defineConfig({
  main: {
    define,
    build: {
      // Workspace packages are TS source — bundle them; real deps stay external.
      externalizeDeps: {
        exclude: ["@ownbase/server", "@ownbase/protocol", "@ownbase/client-core"],
      },
    },
    plugins: [
      {
        name: "ownbase-build-identity",
        apply: "build",
        writeBundle() {
          const out = resolve(import.meta.dirname, "out");
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "build.json"), JSON.stringify(identity, null, 2) + "\n");
        },
      },
    ],
  },
  preload: {
    build: { rolldownOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } },
  },
  renderer: {
    define,
    // As in the web build: the call noise filter's model goes in as a data URL.
    assetsInclude: ["**/*.wasm"],
    plugins: [react(), tailwindcss()],
    // chunkSizeWarningLimit (kB) is the entry budget scripts/check-web-bundle.mjs enforces.
    build: {
      minify: true,
      cssMinify: true,
      chunkSizeWarningLimit: 750,
      rolldownOptions: { output: { codeSplitting: FIRST_PAINT_IN_ONE_FILE } },
    },
  },
});
