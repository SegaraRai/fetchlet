import { createRequire } from "node:module";

import type { Plugin } from "rolldown";

const require = createRequire(import.meta.url);

/** How an artifact provides node:async_hooks. */
export type AsyncContextMode = "serialized" | "propagated";

const modules: Record<AsyncContextMode, string> = {
  serialized: require.resolve("fetchlet/build/async-hooks"),
  propagated: require.resolve("fetchlet/build/propagated-async-hooks"),
};

/**
 * node:async_hooks for the artifact.
 *
 * `"propagated"` is the AsyncLocalStorage of
 * fetchlet/build/propagated-async-hooks, over the engine's async context
 * slot: concurrent runs keep their own stores across await, timers and
 * messages, as in Node. V8 and Boa provide the slot; the module throws when
 * it is evaluated on an engine without one, such as QuickJS.
 *
 * `"serialized"` is the AsyncLocalStorage of fetchlet/build/async-hooks,
 * which keeps a run's store until its callback settles and works on every
 * engine. An App runs one invocation at a time, so the stores of an
 * invocation are its own. Runs that overlap inside one invocation are not
 * isolated from each other; see that module for the exact rules.
 */
export function asyncContextPlugin(mode: AsyncContextMode): Plugin {
  return {
    name: `fetchlet-${mode}-async-context`,
    resolveId(id) {
      if (id === "node:async_hooks" || id === "async_hooks") {
        return modules[mode];
      }
    },
  };
}
