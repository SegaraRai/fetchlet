import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "site-html",
    include: ["*.test.ts"],
  },
});
