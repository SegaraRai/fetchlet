// Downloads, verifies and extracts the pinned AOT toolchain into .cache/tools:
//
//   vp run setup:aot              all of perry, scriptc and zig
//   node tools/aot/install.ts perry
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { toolCache } from "@fetchlet-internal/tools-workspace/paths";

import { releases, type Tool } from "./toolchain.ts";

const requested = process.argv.slice(2).filter((argument) => argument !== "--");
const tools = (requested.length ? requested : Object.keys(releases)) as Tool[];
for (const tool of tools) {
  if (!(tool in releases))
    throw new Error(`Unknown tool ${tool}; choose from ${Object.keys(releases).join(", ")}`);
}

mkdirSync(toolCache, { recursive: true });
for (const tool of tools) {
  const release = releases[tool];
  const archive = resolve(toolCache, release.archive);
  if (!existsSync(archive)) {
    const response = await fetch(release.url);
    if (!response.ok) throw new Error(`${release.url}: ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (digest !== release.sha256) throw new Error(`${tool} release checksum mismatch`);

  const destination = resolve(toolCache, release.destination);
  mkdirSync(destination, { recursive: true });
  // bsdtar, which Windows ships as tar.exe, reads both zip and tar.gz archives.
  const entries = execFileSync("tar", ["-tf", archive], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .filter(Boolean);
  for (const entry of entries) {
    const local = relative(destination, resolve(destination, entry));
    if (local.startsWith("..") || isAbsolute(local))
      throw new Error(`Unsafe archive path ${entry}`);
  }
  execFileSync("tar", ["-xf", archive, "-C", destination], { stdio: "inherit" });
  console.log(
    JSON.stringify({ tool, version: release.version, sha256: release.sha256, destination }),
  );
}
