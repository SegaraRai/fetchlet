// Exports that time AsyncLocalStorage, for tools/bench/src/bin/async-context.rs.
// build-artifact.ts builds it with asyncContext "serialized" or "propagated",
// which selects the node:async_hooks implementation.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<number>();
const read = () => storage.getStore();
// Awaiting a settled promise takes one continuation and allocates nothing.
const settled = Promise.resolve();

/** Operations timed in a loop without awaits. */
const synchronous: Record<string, () => unknown> = {
  // A run around a synchronous callback, as a framework enters a request.
  run: () => storage.run(1, read),
  // A read inside a run, as request helpers read the request.
  getStore: read,
};

/** Operations timed in a loop that awaits each. */
const asynchronous: Record<string, () => Promise<unknown>> = {
  // One await continuation inside a run.
  await: async () => {
    await settled;
  },
  // A run around an async callback that awaits once and reads the store.
  runAwait: () =>
    storage.run(1, async () => {
      await settled;
      return read();
    }),
};

function timeSynchronous(operation: () => unknown, count: number): number {
  for (let index = 0; index < Math.min(count, 1000); index++) {
    operation();
  }
  const start = performance.now();
  for (let index = 0; index < count; index++) {
    operation();
  }
  return performance.now() - start;
}

async function timeAsynchronous(operation: () => Promise<unknown>, count: number): Promise<number> {
  for (let index = 0; index < Math.min(count, 1000); index++) {
    await operation();
  }
  const start = performance.now();
  for (let index = 0; index < count; index++) {
    await operation();
  }
  return performance.now() - start;
}

/**
 * Nanoseconds per operation of `stage`, timed inside a run so that reads
 * find a store. `awaitOutside` times an await outside any run.
 */
export async function measure(stage: string, count: number): Promise<number> {
  let milliseconds: number;
  if (stage === "awaitOutside") {
    milliseconds = await timeAsynchronous(asynchronous.await!, count);
  } else if (stage in synchronous) {
    milliseconds = storage.run(0, () => timeSynchronous(synchronous[stage]!, count));
  } else if (stage in asynchronous) {
    milliseconds = await storage.run(0, () => timeAsynchronous(asynchronous[stage]!, count));
  } else {
    throw new Error("unknown stage " + stage);
  }
  return (milliseconds * 1e6) / count;
}
