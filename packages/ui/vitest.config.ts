import { defaultExclude, defineConfig } from "vitest/config";

// A time limit is there to catch a test that hangs, not one that is slow: on
// a busy machine the five-second default failed tests that pass in one. Each
// project sets it, since a project inside this file takes nothing from the root.
const limits = { testTimeout: 30_000, hookTimeout: 30_000 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "helpers",
          environment: "node",
          exclude: [...defaultExclude, "**/*.dom.test.{ts,tsx}"],
          ...limits,
        },
      },
      {
        test: {
          name: "components",
          include: ["test/**/*.dom.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["./test/setup.ts"],
          ...limits,
        },
      },
    ],
  },
});
