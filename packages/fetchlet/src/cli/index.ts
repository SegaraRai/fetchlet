#!/usr/bin/env node
// The `fetchlet` command.

import { dev, DEV_USAGE, parseDevArguments } from "./dev.ts";

const USAGE = `usage: fetchlet <command>

Commands:
  dev    Build, serve, and build again on changes

${DEV_USAGE}`;

const [command, ...args] = process.argv.slice(2);
if (command === "dev") {
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
