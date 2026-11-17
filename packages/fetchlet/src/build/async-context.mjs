import { readFileSync } from "node:fs";

/**
 * node:async_hooks for engines without async context propagation: the
 * AsyncLocalStorage of ./async-hooks.mjs, which keeps a run's store until its
 * callback settles. An App runs one invocation at a time, so the stores of an
 * invocation are its own. Runs that overlap inside one invocation are not
 * isolated from each other; see that module for the exact rules.
 */
export function serializedAsyncContext() {
  const virtualId = "\0fetchlet:async-hooks";
  return {
    name: "fetchlet-serialized-async-context",
    enforce: "pre",
    resolveId(id) {
      if (id === "node:async_hooks" || id === "async_hooks") {
        return virtualId;
      }
    },
    load(id) {
      if (id === virtualId) {
        return readFileSync(new URL("./async-hooks.mjs", import.meta.url), "utf8");
      }
    },
  };
}
