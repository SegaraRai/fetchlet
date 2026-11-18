// The serialized AsyncLocalStorage that artifacts use in place of node:async_hooks.

import { AsyncLocalStorage } from "@fetchlet/node/async-hooks/serialized";
import { expect, test } from "vite-plus/test";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test("keeps a run's store across its awaits and restores the outer store", async () => {
  const storage = new AsyncLocalStorage<string>();
  const seen: (string | undefined)[] = [];
  await storage.run("request", async () => {
    seen.push(storage.getStore());
    await tick();
    seen.push(storage.getStore());
  });
  expect(seen).toStrictEqual(["request", "request"]);
  expect(storage.getStore()).toBe(undefined);
});

test("overlapping runs that settle out of order leave no settled store behind", async () => {
  // Svelte's asynchronous rendering starts several remote queries inside the
  // render's run; each query runs with its own store and they settle in any order.
  const storage = new AsyncLocalStorage();
  await storage.run("render", async () => {
    const first = deferred();
    const second = deferred();
    const a = storage.run("query a", () => first.promise);
    const b = storage.run("query b", () => second.promise);
    expect(storage.getStore()).toBe("query b");
    first.resolve();
    await a;
    await tick();
    expect(storage.getStore()).toBe("query b");
    second.resolve();
    await b;
    await tick();
    // Before the fix, settling b restored the store of a, which had already settled.
    expect(storage.getStore()).toBe("render");
  });
  expect(storage.getStore()).toBe(undefined);
});

test("restores synchronous runs at once, including when they throw", () => {
  const storage = new AsyncLocalStorage();
  storage.enterWith("outside");
  expect(storage.run("inner", () => storage.getStore())).toBe("inner");
  expect(() =>
    storage.run("failing", () => {
      throw new Error("failed");
    }),
  ).toThrow();
  expect(storage.getStore()).toBe("outside");
  storage.disable();
  expect(storage.getStore()).toBe(undefined);
});

test("rejected runs release their store", async () => {
  const storage = new AsyncLocalStorage();
  await expect(
    storage.run("failing", async () => {
      await tick();
      throw new Error("failed");
    }),
  ).rejects.toThrow();
  await tick();
  expect(storage.getStore()).toBe(undefined);
});

test("enterWith inside a run changes that run's store only", async () => {
  const storage = new AsyncLocalStorage();
  await storage.run("outer", async () => {
    await storage.run("inner", async () => {
      storage.enterWith("changed");
      await tick();
      expect(storage.getStore()).toBe("changed");
    });
    await tick();
    expect(storage.getStore()).toBe("outer");
  });
});

test("snapshot and bind restore every storage's captured store", async () => {
  const first = new AsyncLocalStorage();
  const second = new AsyncLocalStorage();
  const read = () => [first.getStore(), second.getStore()];
  const snapshot = first.run("a", () => second.run("b", () => AsyncLocalStorage.snapshot()));
  const bound = first.run("x", () => AsyncLocalStorage.bind(read));
  expect(snapshot(read)).toStrictEqual(["a", "b"]);
  expect(bound()).toStrictEqual(["x", undefined]);
  expect(read()).toStrictEqual([undefined, undefined]);
});
