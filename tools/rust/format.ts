// Checks the formatting of the Rust workspace and the fuzz targets:
// `vp run check:rust-format`. It needs no build, so the pre-commit hook runs it
// when Rust files are staged; the file paths that hook appends are ignored,
// because `cargo fmt` formats whole packages.

import { cargoAll } from "@fetchlet-internal/tools-workspace/cargo";

cargoAll([
  ["fmt", "--all", "--check"],
  ["fmt", "--manifest-path", "fuzz/Cargo.toml", "--check"],
]);
