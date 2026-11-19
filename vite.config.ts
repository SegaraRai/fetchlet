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
    sortImports: true,
    sortPackageJson: true,
    astro: true,
    svelte: true,
    // Pinned upstream sources are verified byte-for-byte against sources.lock.json.
    ignorePatterns: ["tests/conformance/upstream/**"],
  },
  lint: {
    categories: {
      correctness: "error",
    },
    // Upstream sources and generated API clients are not edited by hand.
    ignorePatterns: ["tests/conformance/upstream/**", "**/*.gen.ts"],
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
      typeAware: true,
    },
    rules: {
      curly: "error",
      eqeqeq: [
        "error",
        "always",
        {
          null: "ignore",
        },
      ],
      "no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          ignoreRestSiblings: true,
          vars: "all",
        },
      ],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  test: {
    projects: [
      "packages/fetchlet/vite.config.ts",
      "packages/node/vite.config.ts",
      "packages/web/vite.config.ts",
      "tools/conformance/vite.config.ts",
    ],
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
      // Conformance runs thousands of short processes, and Boa in particular
      // runs them several times faster optimized.
      "build:lab-release": {
        command: lab + " --release",
        cache: false,
      },
      "build:reference": {
        command: "node tools/docs/reference.ts",
        cache: false,
      },

      // check
      "check:types": {
        command:
          "tsc --noEmit && tsc --noEmit -p tools && tsc --noEmit -p packages/node/tsconfig.json && tsc --noEmit -p packages/fetchlet/tsconfig.json && vp run --filter @fetchlet-internal/example-* check:types",
        cache: false,
      },
      "check:format": {
        command: "vp fmt --check",
        cache: false,
      },
      "check:lint": {
        command: "vp lint",
        cache: false,
      },
      "check:rust": {
        command: "node tools/rust/check.ts",
        cache: false,
      },
      "check:generated": {
        command: "node tools/docs/reference.ts --check",
        cache: false,
      },
      // Runs cargo metadata, whose inputs Vite+ cannot track.
      "check:release": {
        command: "node tools/release/check.ts && pnpm change check",
        cache: false,
      },
      check: {
        command: "",
        dependsOn: [
          "check:types",
          "check:format",
          "check:lint",
          "check:rust",
          "check:generated",
          "check:release",
        ],
      },

      // test
      "test:rust": {
        command: "node tools/rust/test.ts",
        dependsOn: ["build:fixtures"],
        cache: false,
      },
      "test:js": {
        command: "vp test --run",
        cache: false,
      },
      "test:package": {
        command: "node tools/package/test.ts",
        dependsOn: ["@fetchlet/node#build", "@fetchlet/web#build", "fetchlet#build", "build:lab"],
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
        command: "vp test --run --config tools/matrix/vite.config.ts",
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
        dependsOn: ["build:lab-release"],
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
      verify: {
        command: "",
        dependsOn: [
          "check",
          "test:rust",
          "test:conformance",
          "test:polyfills",
          "test:js",
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
      "refresh:asset-archive": {
        command: "node tools/fixtures/asset-archive.ts",
        cache: false,
      },
      "refresh:conformance": {
        command: "node tools/conformance/update-sources.ts",
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
