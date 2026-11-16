import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, posix } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { lock, root } from "./sources.mjs";

const { values } = parseArgs({
  options: {
    suite: { type: "string" },
    revision: { type: "string" },
    add: { type: "string", multiple: true, default: [] },
    remove: { type: "string", multiple: true, default: [] },
  },
});
const suite = values.suite;
if (!["wpt", "test262"].includes(suite) || !/^[0-9a-f]{40}$/.test(values.revision ?? "")) {
  throw new Error("Choose --suite wpt|test262 and a full --revision commit SHA");
}
const repository = suite === "wpt" ? "web-platform-tests/wpt" : "tc39/test262";
const tests = [...new Set([...lock.suites[suite].tests, ...values.add])]
  .filter((file) => !values.remove.includes(file))
  .sort();
if (tests.length === 0) throw new Error("Select at least one test");
for (const file of tests) {
  if (
    !(suite === "wpt" ? file.endsWith(".any.js") : file.startsWith("test/") && file.endsWith(".js"))
  ) {
    throw new Error("Unsupported test source: " + file);
  }
}
const directory = resolve(root, "upstream", suite);
const files = new Map();
function destination(file) {
  const target = resolve(directory, file);
  const local = relative(directory, target);
  if (local.startsWith("..") || isAbsolute(local) || file.includes("?") || file.includes("#")) {
    throw new Error("Unsupported source path: " + file);
  }
  return target;
}

async function download(file) {
  destination(file);
  if (files.has(file)) return;
  const url =
    "https://raw.githubusercontent.com/" + repository + "/" + values.revision + "/" + file;
  const response = await fetch(url);
  if (!response.ok) throw new Error(url + ": " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  files.set(file, bytes);
  const text = bytes.toString("utf8");
  if (suite === "wpt") {
    for (const match of text.matchAll(/^\/\/ META: script=(.+)$/gm)) {
      const dependency = match[1].trim();
      await download(
        dependency.startsWith("/")
          ? dependency.slice(1)
          : posix.normalize(posix.join(posix.dirname(file), dependency)),
      );
    }
  } else {
    const match = /\/\*---([\s\S]*?)---\*\//.exec(text);
    for (const dependency of match ? (parse(match[1]).includes ?? []) : []) {
      await download("harness/" + dependency);
    }
  }
}
const support =
  suite === "wpt"
    ? ["LICENSE.md", "resources/testharness.js"]
    : [
        "LICENSE",
        "INTERPRETING.md",
        "harness/assert.js",
        "harness/sta.js",
        "harness/doneprintHandle.js",
      ];
for (const file of [...support, ...tests]) await download(file);
// No upstream code executes here. Review these changes before running updated tests.
for (const [file, bytes] of files) {
  const target = destination(file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
lock.suites[suite] = {
  repository,
  revision: values.revision,
  tests,
  files: [...files]
    .map(([file, bytes]) => ({
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path)),
};
writeFileSync(resolve(root, "sources.lock.json"), JSON.stringify(lock, null, 2) + "\n");
console.log(
  "Updated " +
    suite +
    ": " +
    tests.length +
    " tests, " +
    files.size +
    " pinned sources. Review before execution.",
);
