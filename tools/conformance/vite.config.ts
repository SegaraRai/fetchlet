import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "conformance",
    include: ["*.test.ts"],
  },
});
