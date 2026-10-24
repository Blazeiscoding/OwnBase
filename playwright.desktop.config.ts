import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  // What the tests launch must be built from the checkout (IMP-08).
  globalSetup: "./tests/e2e/fresh-desktop.setup.ts",
  testMatch: "desktop.spec.ts",
  // Each scenario launches the packaged app on a data folder of its own, so
  // CI can split the one file into shards that run side by side.
  fullyParallel: true,
  workers: 1,
  timeout: 60_000,
  outputDir: "test-results/desktop",
  expect: { timeout: 15_000 },
});
