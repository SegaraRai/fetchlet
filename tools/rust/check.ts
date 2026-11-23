// Checks formatting and lints the Rust workspace: `vp run check:rust`.
// Clippy runs over the same feature combinations as `test:rust` and over the
// examples' Rust code, which `test:rust` does not compile.

import { cargoAll } from "@fetchlet-internal/tools-workspace/cargo";

const httpFeatures = [
  "axum",
  "axum-websocket",
  "actix",
  "actix-websocket",
  "hyper",
  "dev-reload",
  "vite-dev",
];
const axumExamples = [
  "astro-axum",
  "honox-axum",
  "nuxt-axum",
  "qwik-city-axum",
  "react-router-axum",
  "solid-axum",
  "solidstart-axum",
  "sveltekit-axum",
  "tanstack-start-axum",
  "vanilla-axum",
  "vinext-axum",
  "waku-axum",
];
const engines = "quickjs,boa,v8";
const enginesWithWebApis = `${engines},web-apis`;

function clippy(...args: string[]): string[] {
  return ["clippy", "--locked", ...args, "--", "-D", "warnings"];
}

cargoAll([
  ["fmt", "--all", "--check"],
  ["fmt", "--manifest-path", "fuzz/Cargo.toml", "--check"],
  // The host API stays usable without any JavaScript engine feature.
  clippy("-p", "fetchlet", "--all-targets", "--no-default-features"),
  // Web API host implementations build with every optional API and with none.
  clippy("-p", "fetchlet-web", "--all-targets"),
  clippy("-p", "fetchlet-web", "--all-targets", "--no-default-features"),
  clippy(
    "-p",
    "fetchlet",
    "--all-targets",
    "--no-default-features",
    "--features",
    enginesWithWebApis,
  ),
  // Engines without the optional Web APIs.
  clippy("-p", "fetchlet", "--all-targets", "--no-default-features", "--features", engines),
  // Each server feature of fetchlet-http also builds on its own.
  clippy("-p", "fetchlet-http", "--all-targets", "--all-features"),
  ...["", ...httpFeatures].map((feature) =>
    clippy(
      "-p",
      "fetchlet-http",
      "--no-default-features",
      ...(feature ? ["--features", feature] : []),
    ),
  ),
  // Each transport of fetchlet-net also builds on its own.
  clippy("-p", "fetchlet-net", "--all-targets"),
  ...["sockets", "websocket"].map((feature) =>
    clippy("-p", "fetchlet-net", "--no-default-features", "--features", feature),
  ),
  clippy("-p", "fetchlet-lab"),
  clippy(
    ...[...axumExamples, "honox-tauri", "vanilla-cli"].flatMap((name) => ["-p", `example-${name}`]),
    "--all-targets",
  ),
  // The reloading servers of the examples' `dev` tasks. Each package gets
  // its own feature, so they are checked one at a time.
  ...axumExamples.map((name) => clippy("-p", `example-${name}`, "--features", "dev")),
  // The server of vanilla-axum's `dev:vite` task.
  clippy("-p", "example-vanilla-axum", "--features", "vite-dev"),
]);
