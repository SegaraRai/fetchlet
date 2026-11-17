import { defineConfig } from "vite-plus";

// Task names: `build:*` produces local outputs, `test:*` asserts behavior and
// records results/, `check:*` verifies static consistency, `fetch:*` restores
// pinned external inputs, `refresh:*` updates them, and `setup:*` installs
// optional toolchains. `check` and `verify` aggregate the regular gates.
const lab = "node tools/workspace/cargo.ts build --locked -p fetchlet-lab";

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
      // build
      "build:fixtures": {
        command: "node tools/fixtures/build.ts",
      },
      "build:lab": {
        command: lab,
        cache: false,
      },

      // check
      "check:types": {
        command:
          "tsc --noEmit && tsc --noEmit -p tools && tsc --noEmit -p packages/fetchlet/tsconfig.json && vp run --filter @fetchlet-internal/example-* check:types",
        cache: false,
      },
      "check:format": {
        command:
          "vp fmt crates/fetchlet/js crates/fetchlet/tests/fixtures crates/fetchlet-http/tests/fixtures crates/fetchlet-http/tests/contract packages examples fixtures tools tests/conformance/regressions vite.config.ts tsconfig.json package.json --check",
        cache: false,
      },
      check: {
        command: "",
        dependsOn: ["check:types", "check:format"],
      },

      // test
      "test:rust": {
        command: "node tools/rust/test.ts",
        cache: false,
      },
      "test:tools": {
        command: "node --test tools/conformance/runner.test.ts",
        cache: false,
      },
      "test:build": {
        command: "node --test packages/fetchlet/tests/*/*.test.ts",
        cache: false,
      },
      "test:package": {
        command: "node tools/package/test.ts",
        dependsOn: ["fetchlet#build", "build:lab"],
        cache: false,
      },
      "test:matrix": {
        command: "node tools/matrix/runtime.ts",
        dependsOn: ["build:lab", "build:fixtures"],
        cache: false,
      },
      "test:host": {
        command: "node tools/matrix/host.ts",
        dependsOn: ["build:lab", "build:fixtures"],
        cache: false,
      },
      "test:polyfills": {
        command: "node --test tools/matrix/polyfills.test.ts",
        dependsOn: ["build:lab"],
        cache: false,
      },
      "test:url": {
        command: "node tools/matrix/url.ts",
        dependsOn: ["build:lab"],
        cache: false,
      },
      "test:conformance": {
        command: "node tools/conformance/cli.ts",
        dependsOn: ["build:lab"],
        cache: false,
      },
      "test:examples": {
        command: "node tools/examples/test.ts",
        cache: false,
      },
      "test:fuzz": {
        command: "node tools/rust/fuzz.ts",
        cache: false,
      },
      "test:aot": {
        command: "node tools/aot/test.ts",
        cache: false,
      },
      "test:aot-link": {
        command: "node tools/aot/native-link.ts",
        cache: false,
      },
      verify: {
        command: "",
        dependsOn: [
          "check",
          "test:rust",
          "test:tools",
          "test:conformance",
          "test:polyfills",
          "test:build",
          "test:package",
          "test:matrix",
          "test:host",
          "test:examples",
        ],
      },

      // inputs and toolchains
      "fetch:conformance": {
        command: "node tools/conformance/fetch-sources.ts",
        cache: false,
      },
      "refresh:conformance": {
        command: "node tools/conformance/update-sources.ts",
        cache: false,
      },
      "setup:aot": {
        command: "node tools/aot/install.ts",
        cache: false,
      },
      "setup:browser": {
        command: "playwright install --with-deps chromium",
        cache: false,
      },

      // run
      bench: {
        command: "node tools/bench/run.ts",
        cache: false,
      },
      "example:embed": {
        command: "node tools/workspace/cargo.ts run --locked -p fetchlet --example embed",
        dependsOn: ["build:fixtures"],
        cache: false,
      },
    },
  },
});
