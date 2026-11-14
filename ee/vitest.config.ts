import { defineConfig } from "vitest/config";

// ee/cloud is its own package, with its own tests. A time limit is there to
// catch a test that hangs, not one that is slow: on a busy machine the
// five-second default failed tests that pass in one.
// Servers started by these tests hash passwords at a token cost: the real one
// takes a fifth of a second and 64 MiB per sign-in, and they sign in thousands
// of times. packages/server/test/passwordHashing.test.ts covers the real one.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { OWNBASE_PASSWORD_COST: "ln=4,r=8,p=1" },
  },
});
