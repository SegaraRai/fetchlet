// The command that starts an example's Vite dev server on a port.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `vite dev` for the example, as one shell command line: `vp` is a `.cmd`
 * shim on Windows, which only a shell can start, and a shell does not escape
 * separate arguments, so `port` must be a number. Astro starts Vite from its
 * own command line, which picks the next free port when `port` is taken, so
 * callers wait for Vite at the port they named.
 */
export function viteDevCommand(example: string, port: number): string {
  if (
    ["mjs", "js", "ts", "mts"].some((ext) => existsSync(resolve(example, `astro.config.${ext}`)))
  ) {
    return `vp exec astro dev --host 127.0.0.1 --port ${port}`;
  }
  return `vp dev --host 127.0.0.1 --port ${port} --strictPort`;
}
