// Builds a benchmark entry as a fetchlet artifact for one backend:
//   node tools/bench/build-artifact.ts <bare|probe|async-context> <outDir> <backend> [asyncContext]

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildArtifact, type BuildBackend } from "fetchlet/build";

const entries = ["bare", "probe", "async-context"];
const [name, outDir, backend, asyncContext] = process.argv.slice(2);
if (!name || !entries.includes(name) || !outDir || !backend) {
  throw new Error(
    "Usage: build-artifact.ts <bare|probe|async-context> <outDir> <backend> [serialized|propagated]",
  );
}
if (asyncContext !== undefined && asyncContext !== "serialized" && asyncContext !== "propagated") {
  throw new Error(`Unknown asyncContext ${asyncContext}; choose serialized or propagated`);
}
await buildArtifact({
  entry: resolve(import.meta.dirname, name, "entry.ts"),
  outDir,
  framework: name,
  rendering: "buffered",
  backend: backend as BuildBackend,
  asyncContext,
});
await mkdir(resolve(outDir, "client"), { recursive: true });
await writeFile(resolve(outDir, "client/health.txt"), name + " assets\n");
