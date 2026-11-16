import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    // Pinned upstream sources are verified byte-for-byte against sources.lock.json.
    ignorePatterns: ["tests/conformance/upstream/**"],
  },
  run: {
    tasks: {
      "browser:install": { command: "playwright install --with-deps chromium", cache: false },
      "build:fixtures": { command: "node tools/build-fixtures.mjs", cache: false },
      "conformance:update": { command: "node tools/conformance/update-sources.mjs", cache: false },
      "conformance:restore": { command: "node tools/conformance/fetch-sources.mjs", cache: false },
      "test:conformance:runner": {
        command: "node --test tools/conformance/tests/runner.test.mjs",
        cache: false,
      },
      "test:conformance": {
        command: "pwsh -NoProfile -File tools/test-conformance.ps1",
        cache: false,
      },
      "test:polyfills": { command: "pwsh -NoProfile -File tools/test-polyfills.ps1", cache: false },
      "test:matrix": { command: "pwsh -NoProfile -File tools/test-matrix.ps1", cache: false },
      "test:host": { command: "pwsh -NoProfile -File tools/test-js.ps1 -Suite Host", cache: false },
      "test:fuzz": { command: "pwsh -NoProfile -File tools/test-fuzz.ps1", cache: false },
      "test:rust": { command: "pwsh -NoProfile -File tools/test-rust.ps1", cache: false },
      "test:aot": { command: "node tools/test-aot.mjs", cache: false },
      "test:native": { command: "pwsh -NoProfile -File tools/test-native-link.ps1", cache: false },
      "check:types": {
        command:
          "tsc --noEmit && tsc --noEmit -p packages/astro-adapter/tsconfig.json && vp run --filter @fetchlet/example-* check:types",
        cache: false,
      },
      "check:format": {
        command:
          "vp fmt crates/fetchlet/js crates/fetchlet/tests/fixtures crates/fetchlet-axum/tests/fixtures packages examples fixtures tools tests/conformance/regressions vite.config.ts tsconfig.json package.json --check",
        cache: false,
      },
      "example:sveltekit-axum": {
        command: "vp run --filter @fetchlet/example-sveltekit-axum serve",
        cache: false,
      },
      "test:example:sveltekit-axum": {
        command: "pwsh -NoProfile -File tools/test-example.ps1 -Name sveltekit-axum",
        cache: false,
      },
      "example:astro-axum": {
        command: "vp run --filter @fetchlet/example-astro-axum serve",
        cache: false,
      },
      "test:example:astro-axum": {
        command: "pwsh -NoProfile -File tools/test-example.ps1 -Name astro-axum",
        cache: false,
      },
      "test:examples": {
        command: "pwsh -NoProfile -File tools/test-examples.ps1",
        cache: false,
      },
      "example:embed": { command: "pwsh -NoProfile -File tools/run-example.ps1", cache: false },
    },
  },
});
