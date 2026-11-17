// Checks the profile's URL against WPT's urltestdata.json and
// setters_tests.json on Node and each fetchlet backend: `vp run test:url`.
//
// The data comes from the url crate the host parser uses (its package ships
// the WPT files with tests/expected_failures.txt). A fetchlet backend passes
// when its failures are a subset of that list.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildArtifact } from "fetchlet/build";
import { hostBackends, startHost, type HostBackend } from "@fetchlet-internal/tools-workspace/lab";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import {
  environment,
  writeResult,
  type Environment,
} from "@fetchlet-internal/tools-workspace/results";

interface CargoPackage {
  id: string;
  name: string;
  source: string | null;
  manifest_path: string;
}

const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
) as { packages: CargoPackage[] };
const urlCrate = metadata.packages.find(
  (pkg) => pkg.name === "url" && pkg.source?.startsWith("registry+"),
);
if (!urlCrate) throw new Error("the url crate is not in the dependency graph");
const data = resolve(dirname(urlCrate.manifest_path), "tests");
const constructorTests: unknown = JSON.parse(
  readFileSync(resolve(data, "urltestdata.json"), "utf8"),
);
const setterTests: unknown = JSON.parse(readFileSync(resolve(data, "setters_tests.json"), "utf8"));
const expected = new Set(
  readFileSync(resolve(data, "expected_failures.txt"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);

const output = resolve(root, ".cache/url-wpt");
await buildArtifact({
  entry: resolve(import.meta.dirname, "url-wpt.entry.ts"),
  outDir: output,
  framework: "url-wpt",
  backend: "portable",
});
const bundle = resolve(output, "server.js");

async function runSuite(backend: HostBackend): Promise<{ total: number; failures: string[] }> {
  const host = startHost(backend, bundle, 120_000);
  try {
    return await host.call("run", [constructorTests, setterTests]);
  } finally {
    host.close();
  }
}

const report: {
  environment: Environment;
  data: string;
  backends: Record<string, { total: number; failures: number; unexpected: string[] }>;
} = {
  environment: environment(),
  data: urlCrate.id,
  backends: {},
};
let failed = false;
for (const backend of hostBackends) {
  const { total, failures } = await runSuite(backend);
  const unexpected = failures.filter((name) => !expected.has(name));
  report.backends[backend] = { total, failures: failures.length, unexpected };
  // Node's parser is not the url crate, so its list only informs.
  const gated = backend !== "node-reference";
  if (gated && unexpected.length) failed = true;
  console.log(
    `${backend}: ${total - failures.length}/${total} pass, ` +
      `${unexpected.length} outside the url crate's expected failures` +
      (gated ? "" : " (informational)"),
  );
  for (const name of unexpected.slice(0, 20)) console.log("  " + name);
}
writeResult("url-wpt.json", report);
process.exitCode = failed ? 1 : 0;
