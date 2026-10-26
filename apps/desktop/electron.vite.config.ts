import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ARTIFACTS, buildIdentity } from "../../scripts/build-identity.mjs";

// Which source this build is (IMP-08): the hosted server and the window both
// report it, and out/build.json goes into the package for tests to check.
const identity = buildIdentity(ARTIFACTS.desktop.inputs);
const define = { __OWNBASE_BUILD__: JSON.stringify(identity) };

export default defineConfig({
  main: {
    define,
    plugins: [
      // Workspace packages are TS source — bundle them; real deps stay external.
      externalizeDepsPlugin({
        exclude: ["@slackoss/server", "@slackoss/protocol", "@slackoss/client-core"],
      }),
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
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } },
  },
  renderer: {
    define,
    // As in the web build: the call noise filter's model goes in as a data URL.
    assetsInclude: ["**/*.wasm"],
    plugins: [react(), tailwindcss()],
    // chunkSizeWarningLimit (kB) is the entry budget scripts/check-web-bundle.mjs enforces.
    build: { minify: true, cssMinify: true, chunkSizeWarningLimit: 700 },
  },
});
