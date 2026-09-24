import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globalSetup: ["test/support/global-setup.ts"],
    // Integration tests share one real PostgreSQL database and reset it between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
