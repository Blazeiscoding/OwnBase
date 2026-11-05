import { defineConfig } from "vitest/config";

// ee/cloud is its own package, with its own tests. A time limit is there to
// catch a test that hangs, not one that is slow: on a busy machine the
// five-second default failed tests that pass in one.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
