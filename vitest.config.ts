import { defineConfig } from "vitest/config";

// Only run this project's own tests; nested aTimeLogger日历同步工具-* folders
// are archived subprojects that use the node:test runner, not vitest.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
