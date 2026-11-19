// Tests the Rust workspace: `vp run test:rust`. `check:rust` formats and lints it.

import { cargoAll } from "@fetchlet-internal/tools-workspace/cargo";

const engines = "quickjs,boa,v8";

cargoAll([
  // The host API stays usable without any JavaScript engine feature.
  ["test", "--locked", "-p", "fetchlet", "--no-default-features"],
  // Web API host implementations build with every optional API and with none.
  ["test", "--locked", "-p", "fetchlet-web"],
  ["test", "--locked", "-p", "fetchlet-web", "--no-default-features"],
  [
    "test",
    "--locked",
    "-p",
    "fetchlet",
    "--no-default-features",
    "--features",
    `${engines},web-apis`,
  ],
  // fetchlet-http's integrations share tests/contract/ and run it on every engine.
  ["test", "--locked", "-p", "fetchlet-http", "--all-features"],
  // The Tauri example's URI scheme protocol has its own regression tests.
  ["test", "--locked", "-p", "example-honox-tauri"],
]);
