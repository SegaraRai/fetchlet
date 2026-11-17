// Checks the profile's URL against WPT's urltestdata.json and
// setters_tests.json on Node and each fetchlet backend.
//
// The data comes from the url crate the host parser uses (its package ships
// the WPT files with tests/expected_failures.txt). A fetchlet backend passes
// when its failures are a subset of that list. Run through `vp run test:url`,
// which builds fetchlet-lab first.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { buildArtifact } from "../packages/build/src/index.mjs";

const root = resolve(import.meta.dirname, "..");
const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const urlCrate = metadata.packages.find(
  (pkg) => pkg.name === "url" && pkg.source?.startsWith("registry+"),
);
if (!urlCrate) throw new Error("the url crate is not in the dependency graph");
const data = resolve(dirname(urlCrate.manifest_path), "tests");
const constructorTests = JSON.parse(readFileSync(resolve(data, "urltestdata.json"), "utf8"));
const setterTests = JSON.parse(readFileSync(resolve(data, "setters_tests.json"), "utf8"));
const expected = new Set(
  readFileSync(resolve(data, "expected_failures.txt"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);

const output = resolve(root, ".cache/url-wpt");
await buildArtifact({
  entry: resolve(root, "tools/url-wpt/entry.mjs"),
  outDir: output,
  framework: "url-wpt",
  backend: "portable",
});
const bundle = resolve(output, "server.js");

function call(backend) {
  const lab = resolve(
    root,
    process.platform === "win32" ? "target/debug/fetchlet-lab.exe" : "target/debug/fetchlet-lab",
  );
  const [command, args] =
    backend === "node-reference"
      ? [process.execPath, [resolve(root, "tools/node-host.mjs"), bundle]]
      : [lab, [backend, bundle]];
  const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolveReply, reject) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.startsWith("FETCHLET_REPLY ")) return;
      const reply = JSON.parse(line.slice("FETCHLET_REPLY ".length));
      child.stdin.end();
      reply.ok ? resolveReply(reply.value) : reject(new Error(reply.error));
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`${backend} exited ${code}: ${stderr}`)));
    child.stdin.write(
      JSON.stringify({ export: "run", args: [constructorTests, setterTests] }) + "\n",
    );
  });
}

const report = { checkedAt: new Date().toISOString(), data: urlCrate.id, backends: {} };
let failed = false;
for (const backend of ["node-reference", "quickjs", "boa", "v8"]) {
  const { total, failures } = await call(backend);
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
mkdirSync(resolve(root, "results"), { recursive: true });
writeFileSync(resolve(root, "results/url-wpt.json"), JSON.stringify(report, null, 2) + "\n");
process.exit(failed ? 1 : 0);
