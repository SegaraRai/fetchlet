// Writes the body of the GitHub Release for the release version: the section
// pnpm change added to each changelog for that version.
//
//   node tools/release/notes.ts <body file>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "@fetchlet-internal/tools-workspace/paths";

import {
  publishedCrates,
  readPackage,
  releasedPackageDirectories,
  releaseVersion,
} from "./versioning.ts";

const output = process.argv[2];
if (output === undefined) {
  console.error("usage: node tools/release/notes.ts <body file>");
  process.exit(2);
}

const version = releaseVersion();

/** The body of the `## <version>` section of a changelog, without its heading. */
function section(changelog: string): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) {
    return "";
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

const entries: [title: string, directory: string][] = [
  ...releasedPackageDirectories().map((directory): [string, string] => [
    `npm: ${readPackage(directory).name}`,
    directory,
  ]),
  ...publishedCrates.map((crate): [string, string] => [`crate: ${crate}`, `crates/${crate}`]),
];

const sections = entries.flatMap(([title, directory]) => {
  const file = join(root, directory, "CHANGELOG.md");
  const body = existsSync(file) ? section(readFileSync(file, "utf8")) : "";
  return body === "" ? [] : [`## ${title}\n\n${body.replace(/^### /gm, "#### ")}`];
});

writeFileSync(
  output,
  sections.length > 0
    ? `${sections.join("\n\n")}\n`
    : "No changes are recorded for this version.\n",
);
console.log(`v${version}`);
