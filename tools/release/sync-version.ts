// Copies the version pnpm change applied to the Cargo workspace: the workspace
// package version, the exact requirements between the published crates, and
// Cargo.lock. The Version PR workflow runs it after `pnpm version -r`.
//
//   node tools/release/sync-version.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cargo } from "@fetchlet-internal/tools-workspace/cargo";
import { root } from "@fetchlet-internal/tools-workspace/paths";

import { releaseVersion, withCargoVersion } from "./versioning.ts";

const version = releaseVersion();
const manifest = join(root, "Cargo.toml");
writeFileSync(manifest, withCargoVersion(readFileSync(manifest, "utf8"), version));

// Rewrites the lock entries of the workspace members and nothing else.
process.exit(cargo(["update", "--workspace"]));
