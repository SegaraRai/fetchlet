import { createRequire } from "node:module";

import type { Plugin } from "rolldown";

const asyncHooks = createRequire(import.meta.url).resolve("fetchlet/build/async-hooks");

/**
 * node:async_hooks for engines without async context propagation: the
 * AsyncLocalStorage of fetchlet/build/async-hooks, which keeps a run's store
 * until its callback settles. An App runs one invocation at a time, so the
 * stores of an invocation are its own. Runs that overlap inside one
 * invocation are not isolated from each other; see that module for the exact
 * rules.
 */
export function serializedAsyncContext(): Plugin {
  return {
    name: "fetchlet-serialized-async-context",
    resolveId(id) {
      if (id === "node:async_hooks" || id === "async_hooks") {
        return asyncHooks;
      }
    },
  };
}
