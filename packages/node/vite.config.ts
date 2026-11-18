import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
