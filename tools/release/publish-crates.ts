// Publishes the crates of the release version that crates.io does not have yet.
// crates.io versions are immutable, so a rerun after a partial failure
// publishes only the rest. Cargo orders the crates by their dependencies.
//
//   node tools/release/publish-crates.ts [--dry-run]

import { parseArgs } from "node:util";

import { cargo } from "@fetchlet-internal/tools-workspace/cargo";

import { publishedCrates, releaseVersion } from "./versioning.ts";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const dryRun = values["dry-run"];
const version = releaseVersion();

/** The path of a crate in the crates.io sparse index. */
function indexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) {
    return `${lower.length}/${lower}`;
  }
  if (lower.length === 3) {
    return `3/${lower[0]}/${lower}`;
  }
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

/** Whether crates.io already has `version` of `name`, yanked or not. */
async function published(name: string): Promise<boolean> {
  const response = await fetch(`https://index.crates.io/${indexPath(name)}`);
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`the crates.io index answered ${response.status} for ${name}`);
  }
  return (await response.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .some((line) => (JSON.parse(line) as { vers: string }).vers === version);
}

// A dry run packages and builds every crate, so it also covers a version that
// is already published.
const pending = dryRun
  ? [...publishedCrates]
  : (
      await Promise.all(
        publishedCrates.map(async (name) => ((await published(name)) ? undefined : name)),
      )
    ).filter((name) => name !== undefined);

if (pending.length === 0) {
  console.log(`crates.io already has every crate at ${version}.`);
  process.exit(0);
}

console.log(`${dryRun ? "Checking" : "Publishing"} ${pending.join(", ")} at ${version}.`);
process.exit(
  cargo([
    "publish",
    "--locked",
    ...pending.flatMap((name) => ["-p", name]),
    ...(dryRun ? ["--dry-run"] : []),
  ]),
);
