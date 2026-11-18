// A stand-in for src/runtime.ts. The profile installs a global only where the
// runtime lacks one, so on Node it would keep Node's own classes. The
// isolated runtime inherits everything from globalThis except the named
// globals, which it hides, so the profile installs its implementations of
// those on this object and leaves Node's globals untouched.
//
//   vi.mock(import("../src/runtime.ts"), async () =>
//     (await import("./isolated-runtime.ts")).isolatedRuntime(["Headers"]));

import * as streams from "web-streams-polyfill";

/** The fetchlet host bridge: an operation name and JSON input, a JSON reply. */
export type Host = (operation: string, input: string) => string;

export function isolatedRuntime(hidden: readonly string[], host?: Host): { runtime: any } {
  const runtime = Object.create(globalThis);
  for (const name of hidden) {
    Object.defineProperty(runtime, name, {
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  if (host) {
    runtime.__fetchletHost = host;
  }
  return { runtime };
}

/**
 * The Streams classes and the encoding streams built on them. Fetch bodies
 * need the profile's Streams provider, which src/foundation.ts installs.
 */
export const streamGlobals = [...Object.keys(streams), "TextEncoderStream", "TextDecoderStream"];

/** The classes the Fetch API modules install, with the streams under them. */
export const fetchGlobals = [
  ...streamGlobals,
  "Headers",
  "Request",
  "Response",
  "Blob",
  "File",
  "FormData",
  "AbortController",
  "AbortSignal",
  "Event",
  "EventTarget",
  "CustomEvent",
];

/**
 * An engine async context slot on Node: AsyncLocalStorage over Node's
 * AsyncContextFrame carries the mapping through promise reactions, as V8's
 * continuation-preserved embedder data does in an engine.
 */
export async function nodeAsyncContextSlot(): Promise<{
  get(): unknown;
  set(mapping: unknown): void;
}> {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const storage = new AsyncLocalStorage<unknown>();
  return {
    get: () => storage.getStore(),
    set: (mapping) => storage.enterWith(mapping),
  };
}
