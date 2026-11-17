// Builds a benchmark entry as a fetchlet artifact for one backend:
//   node tools/bench/build-artifact.ts <bare|probe> <outDir> <backend>
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildArtifact, type BuildBackend } from "@fetchlet/build";

const [name, outDir, backend] = process.argv.slice(2);
if ((name !== "bare" && name !== "probe") || !outDir || !backend) {
  throw new Error("Usage: build-artifact.ts <bare|probe> <outDir> <backend>");
}
await buildArtifact({
  entry: resolve(import.meta.dirname, name, "entry.ts"),
  outDir,
  framework: name,
  rendering: "buffered",
  backend: backend as BuildBackend,
});
await mkdir(resolve(outDir, "client"), { recursive: true });
await writeFile(resolve(outDir, "client/health.txt"), name + " assets\n");
