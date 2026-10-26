import { defineConfig } from "@playwright/test";

/**
 * The visual check (UX-15): tests/visual/visual.spec.ts. Its pictures are
 * taken on GitHub's Linux runners by the "Visual baselines" workflow, and
 * only Linux compares against them, since other systems draw fonts a little
 * differently. Elsewhere the same screens are walked and checked with axe,
 * and nothing is compared, unless OWNBASE_VISUAL_SNAPSHOTS=1 asks for it, which
 * compares against pictures in a folder for that system that git ignores.
 */
const compare = process.platform === "linux" || process.env.OWNBASE_VISUAL_SNAPSHOTS === "1";

export default defineConfig({
  testDir: "./tests/visual",
  // What the tests launch must be built from the checkout (IMP-08).
  globalSetup: "./tests/e2e/fresh-web.setup.ts",
  outputDir: "test-results/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  ignoreSnapshots: !compare,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
    // A blurred glow can differ by a few pixels between runs of the same machine.
    toHaveScreenshot: { maxDiffPixelRatio: 0.002 },
  },
  use: {
    actionTimeout: 12_000,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
