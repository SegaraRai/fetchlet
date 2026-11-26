import { defineConfig } from "vite-plus";

// Astro and nimbus write `.astro/` and `.nimbus/`, and Pagefind indexes the
// build, so the tasks that run them keep no cache.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "website",
    include: ["*.test.ts", "src/**/*.test.ts", "tests/**/*.test.ts"],
  },
  run: {
    tasks: {
      verify: {
        command: "",
        dependsOn: ["build", "check:types", "test", "check:stillwind"],
      },
      dev: {
        command: "astro dev",
        cache: false,
      },
      build: {
        command: "astro build",
        dependsOn: ["check:types"],
        cache: false,
      },
      preview: {
        command: "astro preview --port 4323",
        cache: false,
      },
      "build:types": {
        command: "astro sync",
        cache: false,
      },
      // Writes the Markdown pages of the build into packages/fetchlet/docs/,
      // which the fetchlet npm package ships and git ignores.
      "build:package-docs": {
        command: "node package-docs.ts",
        dependsOn: ["build"],
        cache: false,
      },
      "check:types": {
        command: "astro check --noSync",
        dependsOn: ["build:types"],
        cache: false,
      },
      "check:stillwind": {
        command: "stillwind fmt --check && stillwind lint --max-warnings=0",
        cache: false,
      },
      "fmt:stillwind": {
        command: "stillwind fmt",
        cache: false,
      },
      test: {
        command: "vp test --run",
        cache: false,
      },
    },
  },
});
