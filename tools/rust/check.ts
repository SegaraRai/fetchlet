// Checks formatting and lints the Rust workspace: `vp run check:rust`.
// Clippy runs over the same feature combinations as `test:rust` and over the
// examples' Rust code, which `test:rust` does not compile.

import { cargoAll } from "@fetchlet-internal/tools-workspace/cargo";

const httpFeatures = ["hyper", "axum", "actix", "dev"];
const axumExamples = [
  "sveltekit-axum",
  "astro-axum",
  "nuxt-axum",
  "react-router-axum",
  "honox-axum",
  "tanstack-start-axum",
  "solidstart-axum",
  "qwik-city-axum",
  "waku-axum",
  "vinext-axum",
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
  clippy("-p", "fetchlet-lab"),
  clippy(
    ...[...axumExamples, "honox-tauri", "vanilla-cli"].flatMap((name) => ["-p", `example-${name}`]),
    "--all-targets",
  ),
  // The reloading server of the examples' `dev` task.
  clippy("-p", "example-vanilla-axum", "--features", "dev"),
]);
