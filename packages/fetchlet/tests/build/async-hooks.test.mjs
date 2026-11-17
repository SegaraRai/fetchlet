// The serialized AsyncLocalStorage that artifacts use in place of node:async_hooks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncLocalStorage } from "../../src/build/async-hooks.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test("keeps a run's store across its awaits and restores the outer store", async () => {
  const storage = new AsyncLocalStorage();
  const seen = [];
  await storage.run("request", async () => {
    seen.push(storage.getStore());
    await tick();
    seen.push(storage.getStore());
  });
  assert.deepEqual(seen, ["request", "request"]);
  assert.equal(storage.getStore(), undefined);
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
    assert.equal(storage.getStore(), "query b");
    first.resolve();
    await a;
    await tick();
    assert.equal(storage.getStore(), "query b");
    second.resolve();
    await b;
    await tick();
    // Before the fix, settling b restored the store of a, which had already settled.
    assert.equal(storage.getStore(), "render");
  });
  assert.equal(storage.getStore(), undefined);
});

test("restores synchronous runs at once, including when they throw", () => {
  const storage = new AsyncLocalStorage();
  storage.enterWith("outside");
  assert.equal(
    storage.run("inner", () => storage.getStore()),
    "inner",
  );
  assert.throws(() =>
    storage.run("failing", () => {
      throw new Error("failed");
    }),
  );
  assert.equal(storage.getStore(), "outside");
  storage.disable();
  assert.equal(storage.getStore(), undefined);
});

test("rejected runs release their store", async () => {
  const storage = new AsyncLocalStorage();
  await assert.rejects(
    storage.run("failing", async () => {
      await tick();
      throw new Error("failed");
    }),
  );
  await tick();
  assert.equal(storage.getStore(), undefined);
});

test("enterWith inside a run changes that run's store only", async () => {
  const storage = new AsyncLocalStorage();
  await storage.run("outer", async () => {
    await storage.run("inner", async () => {
      storage.enterWith("changed");
      await tick();
      assert.equal(storage.getStore(), "changed");
    });
    await tick();
    assert.equal(storage.getStore(), "outer");
  });
});

test("snapshot and bind restore every storage's captured store", async () => {
  const first = new AsyncLocalStorage();
  const second = new AsyncLocalStorage();
  const read = () => [first.getStore(), second.getStore()];
  const snapshot = first.run("a", () => second.run("b", () => AsyncLocalStorage.snapshot()));
  const bound = first.run("x", () => AsyncLocalStorage.bind(read));
  assert.deepEqual(snapshot(read), ["a", "b"]);
  assert.deepEqual(bound(), ["x", undefined]);
  assert.deepEqual(read(), [undefined, undefined]);
});
