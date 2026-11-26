// Checks that the npm packages, the crate placeholders and the Cargo workspace
// agree on the release version and carry the metadata a release needs:
// `vp run check:release`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

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

// The MIT and Apache licenses ask that copies carry the license text, so each
// released package and crate holds a copy of the repository's license files.
const licenseFiles = ["LICENSE-APACHE", "LICENSE-MIT"];
const licenseDirectories = [
  ...releasedPackageDirectories(),
  ...publishedCrates.map((crate) => `crates/${crate}`),
];
for (const file of licenseFiles) {
  const text = readFileSync(join(root, file), "utf8");
  for (const directory of licenseDirectories) {
    const path = join(root, directory, file);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      problems.push(`${directory}/${file} must be a copy of ${file}`);
    }
  }
}
for (const directory of releasedPackageDirectories()) {
  const files = (readPackage(directory) as { files?: string[] }).files ?? [];
  for (const file of licenseFiles.filter((name) => !files.includes(name))) {
    problems.push(`${directory}/package.json must list ${file} in "files"`);
  }
}

// npm shows a package's README without the repository around it, so its
// relative links, and those of the documents it ships that leave the package,
// point nowhere. They link to the repository instead.
const markdownLink = /\]\(([^)\s#]+)/g;
for (const directory of releasedPackageDirectories()) {
  const shipped = [
    "README.md",
    ...((readPackage(directory) as { files?: string[] }).files ?? [])
      .filter((entry) => existsSync(join(root, directory, entry)))
      .flatMap((entry) =>
        statSync(join(root, directory, entry)).isDirectory()
          ? readdirSync(join(root, directory, entry), { recursive: true, encoding: "utf8" }).map(
              (file) => `${entry}/${file.replaceAll("\\", "/")}`,
            )
          : [entry],
      )
      .filter((file) => file.endsWith(".md")),
  ];
  for (const file of shipped) {
    const text = readFileSync(join(root, directory, file), "utf8");
    for (const [, target = ""] of text.matchAll(markdownLink)) {
      if (/^[a-z]+:/i.test(target)) {
        continue;
      }
      const resolved = posix.normalize(posix.join(directory, posix.dirname(file), target));
      if (file === "README.md" || !resolved.startsWith(`${directory}/`)) {
        problems.push(`${directory}/${file} links to ${target}; link to the repository instead`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`Every released package and crate is at ${version}.`);
