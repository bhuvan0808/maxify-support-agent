import { defineConfig } from "vitest/config";

// Unit tests cover the pure modules (output and input guards). Everything that needs the
// database or the agent loop is covered by the eval suites: see docs/EVALS.md.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The default worker pools fail to load test files on Windows when the shell's working
    // directory has a lower-case drive letter ("c:\..."): the test and the runner end up with
    // two copies of vitest. The VM pool does not have that problem and works everywhere.
    pool: "vmThreads",
  },
});
