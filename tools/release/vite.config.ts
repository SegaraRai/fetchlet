import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "release",
    include: ["*.test.ts"],
  },
});
