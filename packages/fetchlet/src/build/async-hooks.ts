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

type Callback<Args extends unknown[], Result> = (...args: Args) => Result;

interface PendingRun {
  store: unknown;
}

const instances = new Set<AsyncLocalStorage<unknown>>();
const runs = new WeakMap<AsyncLocalStorage<unknown>, PendingRun[]>();
const outside = new WeakMap<AsyncLocalStorage<unknown>, unknown>();

function pending(storage: AsyncLocalStorage<unknown>): PendingRun[] {
  let list = runs.get(storage);
  if (!list) {
    list = [];
    runs.set(storage, list);
  }
  return list;
}

// Set each storage to its store in `stores` while callback runs, and until
// the promise it returns settles.
function runWith<Args extends unknown[], Result>(
  stores: Map<AsyncLocalStorage<unknown>, unknown>,
  callback: Callback<Args, Result>,
  args: Args,
): Result {
  const entries = [...stores].map(([storage, store]) => {
    const entry: PendingRun = { store };
    pending(storage).push(entry);
    return [storage, entry] as const;
  });
  const finish = () => {
    for (const [storage, entry] of entries) {
      const list = pending(storage);
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
    }
  };
  let result: Result;
  try {
    result = callback(...args);
  } catch (error) {
    finish();
    throw error;
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    (result as unknown as PromiseLike<unknown>).then(finish, finish);
  } else {
    finish();
  }
  return result;
}

export class AsyncLocalStorage<Store> {
  constructor() {
    instances.add(this);
  }
  static snapshot(): <Args extends unknown[], Result>(
    callback: Callback<Args, Result>,
    ...args: Args
  ) => Result {
    const stores = new Map([...instances].map((storage) => [storage, storage.getStore()]));
    return (callback, ...args) => runWith(stores, callback, args);
  }
  static bind<Args extends unknown[], Result>(
    callback: Callback<Args, Result>,
  ): Callback<Args, Result> {
    const run = AsyncLocalStorage.snapshot();
    return (...args) => run(callback, ...args);
  }
  getStore(): Store | undefined {
    const list = runs.get(this);
    return (list?.length ? list[list.length - 1].store : outside.get(this)) as Store | undefined;
  }
  run<Args extends unknown[], Result>(
    store: Store,
    callback: Callback<Args, Result>,
    ...args: Args
  ): Result {
    return runWith(new Map([[this, store]]), callback, args);
  }
  enterWith(store: Store): void {
    const list = runs.get(this);
    if (list?.length) list[list.length - 1].store = store;
    else outside.set(this, store);
  }
  exit<Args extends unknown[], Result>(callback: Callback<Args, Result>, ...args: Args): Result {
    return runWith(new Map([[this, undefined]]), callback, args);
  }
  disable(): void {
    runs.delete(this);
    outside.delete(this);
  }
}
