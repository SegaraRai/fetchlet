// Checks that the npm packages, the crate placeholders and the Cargo workspace
// agree on the release version and carry the metadata a release needs:
// `vp run check:release`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "@fetchlet-internal/tools-workspace/paths";

import {
  byName,
  cargoPackages,
  cratePlaceholder,
  fixedGroup,
  publishedCrates,
  readPackage,
  releasedPackageDirectories,
  releaseVersion,
  withCargoVersion,
} from "./versioning.ts";

const problems: string[] = [];
const version = releaseVersion();

// pnpm change bumps the fixed group together; it must name every released package.
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const fixedSection = /^ {2}fixed:\r?\n((?: {4}.*\r?\n)+)/m.exec(workspace)?.[1] ?? "";
const configured = [...fixedSection.matchAll(/"([^"]+)"/g)]
  .map((match) => match[1] ?? "")
  .sort(byName);
const expected = fixedGroup();
if (configured.join() !== expected.join()) {
  problems.push(
    `versioning.fixed in pnpm-workspace.yaml lists ${configured.join(", ") || "nothing"}; ` +
      `expected ${expected.join(", ")}`,
  );
}

for (const crate of publishedCrates) {
  const manifest = readPackage(`crates/${crate}`);
  if (manifest.name !== cratePlaceholder(crate) || manifest.private !== true) {
    problems.push(`crates/${crate}/package.json must be the private ${cratePlaceholder(crate)}`);
  }
  if (manifest.version !== version) {
    problems.push(`${manifest.name} is ${manifest.version}; the release is ${version}`);
  }
}

for (const directory of releasedPackageDirectories()) {
  const manifest = readPackage(directory) as ReturnType<typeof readPackage> & {
    license?: string;
    repository?: { directory?: string };
  };
  if (manifest.version !== version) {
    problems.push(`${manifest.name} is ${manifest.version}; the release is ${version}`);
  }
  if (manifest.license !== "MIT OR Apache-2.0") {
    problems.push(`${manifest.name} must declare the license "MIT OR Apache-2.0"`);
  }
  if (manifest.repository?.directory !== directory) {
    problems.push(`${manifest.name} must name its repository directory "${directory}"`);
  }
}

const cargoManifest = readFileSync(join(root, "Cargo.toml"), "utf8");
if (withCargoVersion(cargoManifest, version) !== cargoManifest) {
  problems.push(`Cargo.toml does not carry ${version}; run node tools/release/sync-version.ts`);
}

const packages = cargoPackages();
const publishable = packages
  .filter((member) => member.publish === null)
  .map((member) => member.name)
  .sort(byName);
if (publishable.join() !== [...publishedCrates].sort(byName).join()) {
  problems.push(
    `the publishable crates are ${publishable.join(", ")}; ` +
      `expected ${[...publishedCrates].sort(byName).join(", ")} (publishedCrates in tools/release/versioning.ts)`,
  );
}
for (const member of packages.filter((each) => each.publish === null)) {
  if (member.version !== version) {
    problems.push(`crate ${member.name} is ${member.version}; the release is ${version}`);
  }
  for (const field of ["license", "repository", "description"] as const) {
    if (!member[field]) {
      problems.push(`crate ${member.name} has no ${field}`);
    }
  }
  for (const dependency of member.dependencies) {
    if (dependency.path !== undefined && dependency.req !== `=${version}`) {
      problems.push(
        `crate ${member.name} requires ${dependency.name} ${dependency.req}; ` +
          `published crates require each other at =${version}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`Every released package and crate is at ${version}.`);
