import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The sandbox tests spin up V8 isolates; run them sequentially so we
    // don't blow the heap when many isolates are alive at once.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
