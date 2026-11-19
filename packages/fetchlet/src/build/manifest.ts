// Writing an artifact's fetchlet.json.

import { renameSync, writeFileSync } from "node:fs";

/**
 * Write `manifest` to `path` through a temporary file and a rename, so a
 * reader sees either the previous manifest or the complete new one. The
 * manifest is written after the files it names: fetchlet-http's `DevReload`
 * takes a new manifest as a finished build.
 */
export function writeManifest(path: string, manifest: object): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(temporary, path);
}
