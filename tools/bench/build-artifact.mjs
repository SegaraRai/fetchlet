// Builds a benchmark entry as a fetchlet artifact for one backend:
//   node tools/bench/build-artifact.mjs <bare|probe> <outDir> <backend>
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildArtifact } from "../../packages/build/src/index.mjs";

const [name, outDir, backend] = process.argv.slice(2);
if (name !== "bare" && name !== "probe") throw new Error("unknown entry " + name);
await buildArtifact({
  entry: resolve(import.meta.dirname, name, "entry.mjs"),
  outDir,
  framework: name,
  rendering: "buffered",
  backend,
});
await mkdir(resolve(outDir, "client"), { recursive: true });
await writeFile(resolve(outDir, "client/health.txt"), name + " assets\n");
