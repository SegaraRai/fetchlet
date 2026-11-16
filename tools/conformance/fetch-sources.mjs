import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { lock, root, verifySources } from "./sources.mjs";

for (const [suite, configuration] of Object.entries(lock.suites)) {
  if (!/^[0-9a-f]{40}$/.test(configuration.revision)) throw new Error("Expected a pinned commit");
  if (!["web-platform-tests/wpt", "tc39/test262"].includes(configuration.repository)) {
    throw new Error("Unrecognized upstream repository");
  }
  const directory = resolve(root, "upstream", suite);
  for (const record of configuration.files) {
    const destination = resolve(directory, record.path);
    const local = relative(directory, destination);
    if (local.startsWith("..") || isAbsolute(local)) throw new Error("Unsafe source path");
    const url =
      "https://raw.githubusercontent.com/" +
      configuration.repository +
      "/" +
      configuration.revision +
      "/" +
      record.path;
    const response = await fetch(url);
    if (!response.ok) throw new Error(url + ": " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256)
      throw new Error("Checksum mismatch");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}
verifySources();
console.log("Restored and verified all pinned upstream source files.");
