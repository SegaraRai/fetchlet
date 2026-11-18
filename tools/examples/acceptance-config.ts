// The Vitest configuration of an example's end-to-end suites, which each
// example's acceptance.config.ts reexports: `vp test --run --config
// acceptance.config.ts` from the example directory, as tools/examples/test.ts
// runs it. The suites share one server and record one result file, so files
// and tests run one at a time, in order.

import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    reporters: ["verbose"],
    sequence: { concurrent: false },
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
