// Checks that the committed scripts the crates embed are up to date:
// `vp run check:generated`. Each crate's vite.config.ts compiles its js-src/
// sources into js/ (`vp run build:scripts`); this builds them again
// into .cache/ and compares the files.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { root } from "@fetchlet-internal/tools-workspace/paths";
import { run } from "@fetchlet-internal/tools-workspace/process";

const crates = ["fetchlet", "fetchlet-http"];

function files(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function read(path: string): string {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

let stale = false;
for (const crate of crates) {
  const committed = resolve(root, "crates", crate, "js");
  const fresh = resolve(root, ".cache/scripts", crate);
  rmSync(fresh, { recursive: true, force: true });
  const code = run("vp", ["pack"], {
    cwd: resolve(root, "crates", crate),
    env: { ...process.env, FETCHLET_SCRIPTS_OUT_DIR: fresh },
    log: resolve(root, ".cache/scripts", `${crate}.log`),
  });
  if (code !== 0) {
    console.error(
      `[scripts] building crates/${crate}/js-src failed; see .cache/scripts/${crate}.log`,
    );
    process.exit(code);
  }

  const names = new Set([...files(committed), ...files(fresh)]);
  for (const name of names) {
    const current = resolve(committed, name);
    const expected = resolve(fresh, name);
    if (!existsSync(current) || !existsSync(expected) || read(current) !== read(expected)) {
      console.error(`[scripts] crates/${crate}/js/${name} is stale`);
      stale = true;
    }
  }
}

if (stale) {
  console.error("[scripts] run `vp run build:scripts` and commit the crates' js/");
  process.exit(1);
}
console.log("[scripts] the embedded scripts match their sources");
