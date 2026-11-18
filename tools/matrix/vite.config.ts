import { defineConfig } from "vite-plus";

// The polyfill matrix builds artifacts and runs them through fetchlet-lab, so
// it is not a root test project; `vp run test:polyfills` runs it after
// `build:lab`.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "polyfills",
    include: ["polyfills.test.ts"],
    hookTimeout: 600_000,
    testTimeout: 600_000,
  },
});
