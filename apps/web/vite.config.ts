import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { precompress } from "./precompress";
import { ARTIFACTS, buildIdentity } from "../../scripts/build-identity.mjs";

// Which source this build is (IMP-08): shown in diagnostics, and written
// beside the build so tests can refuse a client older than the checkout.
const identity = buildIdentity(ARTIFACTS.web.inputs);
const stampBuild: Plugin = {
  name: "ownbase-build-identity",
  apply: "build",
  writeBundle(options) {
    writeFileSync(join(options.dir!, "build.json"), JSON.stringify(identity, null, 2) + "\n");
  },
};

export default defineConfig({
  define: { __OWNBASE_BUILD__: JSON.stringify(identity) },
  // The call noise filter's model is bundled into its chunk as a data URL
  // (`?inline`), which Vite does for assets it knows; WebAssembly is not one.
  assetsInclude: ["**/*.wasm"],
  plugins: [react(), tailwindcss(), stampBuild, precompress()],
  // kB, the entry budget scripts/check-web-bundle.mjs enforces.
  build: { chunkSizeWarningLimit: 700 },
});
