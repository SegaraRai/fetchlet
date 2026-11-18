// The Node reference host for a bundle: evaluates it in this context, with
// Node's native Web APIs, and answers the line protocol described in lab.ts.
//
//   node tools/workspace/node-host.ts <bundle.js>

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import readline from "node:readline";
import vm from "node:vm";

const bundle = process.argv[2];
if (!bundle) {
  throw new Error("Usage: node-host.ts <bundle.js>");
}

// The async context slot, installed before the bundle as an engine does:
// Node's AsyncContextFrame carries it through promise reactions as V8's
// continuation-preserved embedder data does.
const frame = new AsyncLocalStorage<unknown>();
(globalThis as { __fetchletAsyncContext?: unknown }).__fetchletAsyncContext = {
  get: () => frame.getStore(),
  set: (mapping: unknown) => frame.enterWith(mapping),
};

vm.runInThisContext(readFileSync(bundle, "utf8"), {
  filename: bundle,
});

// Node reports promise rejections through process events after its
// microtask checkpoint. Hand them to the profile's hooks, as a fetchlet
// engine's rejection tracker does, instead of ending the process.
const profile = globalThis as {
  __fetchletPromiseRejection?: (promise: unknown, reason: unknown, handled: boolean) => void;
  __fetchletFlushRejections?: () => void;
};
process.on("unhandledRejection", (reason, promise) => {
  if (!profile.__fetchletPromiseRejection) {
    console.error("Uncaught (in promise)", reason);
    return;
  }
  profile.__fetchletPromiseRejection(promise, reason, false);
  profile.__fetchletFlushRejections?.();
});
process.on("rejectionHandled", (promise) => {
  profile.__fetchletPromiseRejection?.(promise, undefined, true);
  profile.__fetchletFlushRejections?.();
});

const exports = (globalThis as any).fetchletExports as Record<string, (...args: any[]) => unknown>;
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const { export: name, args = [] } = JSON.parse(line) as { export: string; args?: unknown[] };
    // Each invocation starts in the empty async context, as invoke.js does.
    frame.enterWith(undefined);
    const exported = exports[name];
    if (typeof exported !== "function") {
      throw new TypeError(`No exported function ${name}`);
    }
    const value = await exported(...args);
    console.log("FETCHLET_REPLY " + JSON.stringify({ ok: true, value }));
  } catch (error) {
    console.log("FETCHLET_REPLY " + JSON.stringify({ ok: false, error: describe(error) }));
  }
}

function describe(error: unknown): string {
  return String((error as Error)?.stack ?? error);
}
