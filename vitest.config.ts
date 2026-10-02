import { defineConfig } from "vitest/config";

export default defineConfig({
  // The sources use NodeNext ESM specifiers ("./acp.js"); map them back to the TS files
  // so tests can import src directly without a build step.
  resolve: {
    alias: [{ find: /^(\..*?)\.js$/, replacement: "$1" }],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 40000,
    hookTimeout: 40000,
    // The daemon tests spawn real child processes and unix sockets; running files in
    // parallel is fine, but keep a single fork per file to reduce flakiness.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: ["default"],
  },
});
