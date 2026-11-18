import { posix } from "node:path";

import { source } from "./sources.ts";

function dependencies(file: string, seen = new Set<string>()): string[] {
  const result: string[] = [];
  for (const match of source("wpt", file).matchAll(/^\/\/ META: script=(.+)$/gm)) {
    const name = match[1]!.trim();
    const dependency = name.startsWith("/")
      ? name.slice(1)
      : posix.normalize(posix.join(posix.dirname(file), name));
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    result.push(...dependencies(dependency, seen), dependency);
  }
  return result;
}

/** Relative JSON URLs that a script fetches with a literal argument. */
export function fetchedData(script: string): string[] {
  return Array.from(
    script.matchAll(/\bfetch\(\s*(['"])([^'"]+\.json)\1\s*\)/g),
    (match) => match[2]!,
  );
}

/** Sources execute as native global script code, with the upstream shell harness. */
export function wptProgram(file: string): string {
  const scripts = [
    ...dependencies(file).map((dependency) => source("wpt", dependency)),
    source("wpt", file),
  ];
  const data: Record<string, string> = {};
  for (const url of scripts.flatMap(fetchedData)) {
    data[url] = source("wpt", posix.normalize(posix.join(posix.dirname(file), url)));
  }
  return wptScript(scripts, data);
}

/**
 * The upstream harness and scripts. `data` answers fetches of pinned JSON by
 * the relative URL the test uses, as the WPT server would.
 */
export function wptScript(scripts: string[], data: Record<string, string> = {}): string {
  const served =
    Object.keys(data).length === 0
      ? ""
      : `(() => {
      const data = ${JSON.stringify(data)};
      const runtimeFetch = globalThis.fetch;
      globalThis.fetch = (input, init) =>
        typeof input === "string" && Object.hasOwn(data, input)
          ? Promise.resolve(new Response(data[input], {
              headers: { "content-type": "application/json" },
            }))
          : runtimeFetch(input, init);
    })();`;
  return [
    "globalThis.self ??= globalThis;",
    // WPT's common/subset-tests.js reads location.search, as in a worker.
    `globalThis.location ??= { href: "https://wpt.invalid/", search: "", hash: "" };`,
    served,
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
