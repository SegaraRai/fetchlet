#!/usr/bin/env node
// The `fetchlet` command.

import { build, BUILD_USAGE, parseBuildArguments } from "./build.ts";
import { dev, DEV_USAGE, parseDevArguments } from "./dev.ts";

const USAGE = `usage: fetchlet <command>

Commands:
  build  Build a server module into an artifact without Vite
  dev    Build, serve, and build again on changes

${BUILD_USAGE}

${DEV_USAGE}`;

const [command, ...args] = process.argv.slice(2);
if (command === "build") {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(BUILD_USAGE);
    process.exit(0);
  }
  const options = parseBuildArguments(args, process.cwd());
  if ("error" in options) {
    console.error(`fetchlet build: ${options.error}\n\n${BUILD_USAGE}`);
    process.exit(2);
  }
  process.exit(await build(options));
} else if (command === "dev") {
  const options = parseDevArguments(args, process.cwd());
  if ("error" in options) {
    console.error(`fetchlet dev: ${options.error}\n\n${DEV_USAGE}`);
    process.exit(2);
  }
  process.exit(await dev(options));
} else if (command === undefined || command === "--help" || command === "-h") {
  console.log(USAGE);
} else {
  console.error(`fetchlet: unknown command ${command}\n\n${USAGE}`);
  process.exit(2);
}
