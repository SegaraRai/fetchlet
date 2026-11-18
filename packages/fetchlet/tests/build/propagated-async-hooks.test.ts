// The propagated AsyncLocalStorage that artifacts use in place of
// node:async_hooks on engines with an async context slot. On Node the slot
// is an AsyncLocalStorage over AsyncContextFrame, which propagates through
// promise reactions as V8's embedder data does, so each scenario runs with
// fetchlet's classes and with Node's and must give the same result.

import * as node from "node:async_hooks";

import { describe, expect, test, vi } from "vite-plus/test";

const frame = new node.AsyncLocalStorage<unknown>();
(globalThis as any).__fetchletAsyncContext = {
  get: () => frame.getStore(),
  set: (mapping: unknown) => frame.enterWith(mapping),
};
const fetchlet = await import("fetchlet/build/propagated-async-hooks");

type Hooks = Pick<typeof node, "AsyncLocalStorage" | "AsyncResource">;

const implementations: Array<[string, Hooks]> = [
  ["fetchlet", fetchlet as unknown as Hooks],
  ["node", node],
];

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Each scenario's result with fetchlet's classes equals Node's. */
async function compare(scenario: (hooks: Hooks) => unknown): Promise<unknown> {
  const results = [];
  for (const [, hooks] of implementations) {
    results.push(await scenario(hooks));
  }
  expect(results[0]).toStrictEqual(results[1]);
  return results[0];
}

describe("AsyncLocalStorage", () => {
  test("keeps concurrent runs apart across awaits and timers", async () => {
    const result = await compare(({ AsyncLocalStorage }) => {
      const storage = new AsyncLocalStorage<string>();
      const reader = (store: string) =>
        storage.run(store, async () => {
          const seen = [storage.getStore()];
          await tick();
          seen.push(storage.getStore());
          await new Promise((resolve) => setTimeout(resolve, 1));
          seen.push(storage.getStore());
          return seen;
        });
      return Promise.all([reader("a"), reader("b")]);
    });
    expect(result).toStrictEqual([
      ["a", "a", "a"],
      ["b", "b", "b"],
    ]);
  });

  test("returns the default value outside any run, and undefined inside exit", async () => {
    await compare(({ AsyncLocalStorage }) => {
      const storage = new AsyncLocalStorage<string>({ defaultValue: "default", name: "request" });
      return [
        storage.getStore(),
        storage.run("inside", () => [storage.getStore(), storage.exit(() => storage.getStore())]),
        (storage as unknown as { name: string }).name,
      ];
    });
  });

  test("enterWith lasts through the rest of the run, not past it", async () => {
    const result = await compare(async ({ AsyncLocalStorage }) => {
      const storage = new AsyncLocalStorage<string>();
      const inner = await storage.run("outer", async () => {
        await tick();
        storage.enterWith("entered");
        await tick();
        return storage.getStore();
      });
      return [inner, storage.getStore() ?? null];
    });
    expect(result).toStrictEqual(["entered", null]);
  });

  test("disable unsets the store until the next run", async () => {
    await compare(({ AsyncLocalStorage }) => {
      const storage = new AsyncLocalStorage<string>();
      return storage.run("before", () => {
        storage.disable();
        return [storage.getStore() ?? null, storage.run("after", () => storage.getStore())];
      });
    });
  });

  test("snapshot and bind run callbacks in the captured context", async () => {
    const result = await compare(({ AsyncLocalStorage }) => {
      const storage = new AsyncLocalStorage<string>();
      const [snapshot, bound] = storage.run("captured", () => [
        AsyncLocalStorage.snapshot(),
        AsyncLocalStorage.bind((suffix: string) => storage.getStore() + suffix),
      ]);
      return storage.run("current", () => [
        snapshot(() => storage.getStore()),
        (bound as (suffix: string) => string)("!"),
        storage.getStore(),
      ]);
    });
    expect(result).toStrictEqual(["captured", "captured!", "current"]);
  });
});

describe("AsyncResource", () => {
  test("runs callbacks in the context of its creation", async () => {
    const result = await compare(({ AsyncLocalStorage, AsyncResource }) => {
      const storage = new AsyncLocalStorage<string>();
      const resource = storage.run("created", () => new AsyncResource("test"));
      const bound = storage.run("bound", () =>
        AsyncResource.bind(function (this: unknown, suffix: string) {
          return [storage.getStore() + suffix, this];
        }),
      );
      return storage.run("current", () => [
        resource.runInAsyncScope((value: string) => storage.getStore() + value, null, "?"),
        resource.bind(() => storage.getStore())(),
        bound.call("receiver", "!"),
      ]);
    });
    expect(result).toStrictEqual(["created?", "created", ["bound!", "receiver"]]);
  });
});

test("refuses to load on an engine without an async context slot", async () => {
  const slot = (globalThis as any).__fetchletAsyncContext;
  delete (globalThis as any).__fetchletAsyncContext;
  vi.resetModules();
  try {
    await expect(import("fetchlet/build/propagated-async-hooks")).rejects.toThrow(
      'build with asyncContext: "serialized"',
    );
  } finally {
    (globalThis as any).__fetchletAsyncContext = slot;
  }
});
