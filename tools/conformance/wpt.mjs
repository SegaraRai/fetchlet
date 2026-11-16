import { posix } from "node:path";
import { source } from "./sources.mjs";

function dependencies(file, seen = new Set()) {
  const result = [];
  for (const match of source("wpt", file).matchAll(/^\/\/ META: script=(.+)$/gm)) {
    const name = match[1].trim();
    const dependency = name.startsWith("/")
      ? name.slice(1)
      : posix.normalize(posix.join(posix.dirname(file), name));
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    result.push(...dependencies(dependency, seen), dependency);
  }
  return result;
}

/** Sources execute as native global script code, with the upstream shell harness. */
export function wptProgram(file) {
  return wptScript([
    ...dependencies(file).map((dependency) => source("wpt", dependency)),
    source("wpt", file),
  ]);
}

export function wptScript(scripts) {
  return [
    "globalThis.self ??= globalThis;",
    source("wpt", "resources/testharness.js"),
    `const fetchletWptReport = new Promise(resolve => {
      setup({ explicit_done: true });
      add_completion_callback((tests, status) => resolve({
        harness: { status: status.status, message: status.message },
        tests: tests.map(test => ({
          name: test.name, status: test.status, message: test.message,
        })),
      }));
    });
    var fetchletExports = { run() { return fetchletWptReport; } };`,
    ...scripts,
    "done();",
  ].join("\n");
}
