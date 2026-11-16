import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

export const root = resolve("tests/conformance");
export const lock = JSON.parse(readFileSync(resolve(root, "sources.lock.json"), "utf8"));

export function source(suite, file) {
  const record = lock.suites[suite].files.find((entry) => entry.path === file);
  if (!record) throw new Error("Unpinned upstream dependency: " + suite + "/" + file);
  const directory = resolve(root, "upstream", suite);
  const location = resolve(directory, file);
  const local = relative(directory, location);
  if (local.startsWith("..") || isAbsolute(local)) throw new Error("Unsafe source path");
  const bytes = readFileSync(location);
  if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new Error("Upstream checksum mismatch: " + suite + "/" + file);
  }
  return bytes.toString("utf8");
}

export function verifySources() {
  for (const [suite, configuration] of Object.entries(lock.suites)) {
    for (const file of configuration.files) source(suite, file.path);
  }
}
