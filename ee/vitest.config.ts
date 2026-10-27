import { defineConfig } from "vitest/config";

// ee/cloud is its own package, with its own tests.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
