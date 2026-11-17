// Formats, lints and tests the Rust workspace: `vp run test:rust`.
import { cargoAll } from "@fetchlet-internal/tools-workspace/cargo";

const httpFeatures = ["hyper", "axum", "actix"];
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

cargoAll([
  ["fmt", "--all", "--check"],
  ["fmt", "--manifest-path", "fuzz/Cargo.toml", "--check"],
  // The host API stays usable without any JavaScript engine feature.
  ["test", "--locked", "-p", "fetchlet", "--no-default-features"],
  [
    "clippy",
    "--locked",
    "-p",
    "fetchlet",
    "--all-targets",
    "--no-default-features",
    "--",
    "-D",
    "warnings",
  ],
  ["test", "--locked", "-p", "fetchlet", "--no-default-features", "--features", engines],
  [
    "clippy",
    "--locked",
    "-p",
    "fetchlet",
    "--all-targets",
    "--no-default-features",
    "--features",
    engines,
    "--",
    "-D",
    "warnings",
  ],
  // fetchlet-http's integrations share tests/contract/ and run it on every
  // engine. Each server feature also builds on its own.
  ["test", "--locked", "-p", "fetchlet-http", "--all-features"],
  [
    "clippy",
    "--locked",
    "-p",
    "fetchlet-http",
    "--all-targets",
    "--all-features",
    "--",
    "-D",
    "warnings",
  ],
  ...["", ...httpFeatures].map((feature) => [
    "clippy",
    "--locked",
    "-p",
    "fetchlet-http",
    "--no-default-features",
    ...(feature ? ["--features", feature] : []),
    "--",
    "-D",
    "warnings",
  ]),
  ["clippy", "--locked", "-p", "fetchlet-lab", "--", "-D", "warnings"],
  // The Tauri example's URI scheme protocol has its own regression tests.
  ["test", "--locked", "-p", "example-honox-tauri"],
  [
    "clippy",
    "--locked",
    ...[...axumExamples, "honox-tauri"].flatMap((name) => ["-p", `example-${name}`]),
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ],
]);
