/**
 * node:async_hooks for engines without async context propagation. An App runs
 * one invocation at a time, so `run` keeps the store until the callback's
 * promise settles, across its awaits, and then restores the previous store.
 * Concurrent `run` calls with different stores inside one invocation are
 * not isolated from each other. `snapshot` and `bind` capture every storage
 * and restore it the same way.
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
        return `const instances = new Set();

        // Set each storage to its store in stores while callback runs, and
        // until the promise it returns settles.
        function runWith(stores, callback, args) {
          const previous = new Map();
          for (const [storage, store] of stores) {
            previous.set(storage, storage.getStore());
            storage.enterWith(store);
          }
          const restore = () => {
            for (const [storage, store] of stores) {
              if (storage.getStore() === store) storage.enterWith(previous.get(storage));
            }
          };
          let result;
          try {
            result = callback(...args);
          } catch (error) {
            restore();
            throw error;
          }
          if (result && typeof result.then === "function") {
            result.then(restore, restore);
          } else {
            restore();
          }
          return result;
        }

        export class AsyncLocalStorage {
          #store;
          constructor() {
            instances.add(this);
          }
          static snapshot() {
            const stores = new Map([...instances].map((storage) => [storage, storage.getStore()]));
            return (callback, ...args) => runWith(stores, callback, args);
          }
          static bind(callback) {
            const run = AsyncLocalStorage.snapshot();
            return (...args) => run(callback, ...args);
          }
          getStore() {
            return this.#store;
          }
          run(store, callback, ...args) {
            return runWith(new Map([[this, store]]), callback, args);
          }
          enterWith(store) {
            this.#store = store;
          }
          exit(callback, ...args) {
            return this.run(undefined, callback, ...args);
          }
          disable() {
            this.#store = undefined;
          }
        }`;
      }
    },
  };
}
