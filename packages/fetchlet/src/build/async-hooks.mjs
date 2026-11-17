// node:async_hooks for engines without async context propagation. An App runs
// one invocation at a time, so `run` keeps the store until the callback's
// promise settles, across its awaits.
//
// Each storage keeps the runs that are still pending in start order, and its
// store is that of the latest pending run. A run that settles leaves the list
// wherever it is, so runs that overlap and settle in any order leave the
// storage at the store of a run that is still pending, or at the store set
// outside any run. While runs overlap, code of any of them sees the latest
// one's store: concurrent runs inside one invocation are not isolated.

const instances = new Set();
const runs = new WeakMap();
const outside = new WeakMap();

function pending(storage) {
  let list = runs.get(storage);
  if (!list) {
    list = [];
    runs.set(storage, list);
  }
  return list;
}

// Set each storage to its store in `stores` while callback runs, and until
// the promise it returns settles.
function runWith(stores, callback, args) {
  const entries = [...stores].map(([storage, store]) => {
    const entry = { store };
    pending(storage).push(entry);
    return [storage, entry];
  });
  const finish = () => {
    for (const [storage, entry] of entries) {
      const list = pending(storage);
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
    }
  };
  let result;
  try {
    result = callback(...args);
  } catch (error) {
    finish();
    throw error;
  }
  if (result && typeof result.then === "function") {
    result.then(finish, finish);
  } else {
    finish();
  }
  return result;
}

export class AsyncLocalStorage {
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
    const list = runs.get(this);
    return list?.length ? list[list.length - 1].store : outside.get(this);
  }
  run(store, callback, ...args) {
    return runWith(new Map([[this, store]]), callback, args);
  }
  enterWith(store) {
    const list = runs.get(this);
    if (list?.length) list[list.length - 1].store = store;
    else outside.set(this, store);
  }
  exit(callback, ...args) {
    return this.run(undefined, callback, ...args);
  }
  disable() {
    runs.delete(this);
    outside.delete(this);
  }
}
