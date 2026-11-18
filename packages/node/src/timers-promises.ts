// node:timers/promises: promise forms of the timers, with AbortSignal
// support, an async iterator for intervals and the scheduler object.

import { invalidArgType } from "./errors.ts";
import {
  clearInterval,
  setImmediate as immediate,
  setInterval as interval,
  setTimeout as timeout,
} from "./timers.ts";

interface TimerOptions {
  signal?: AbortSignal;
  ref?: boolean;
}

function abortError(signal: AbortSignal): Error {
  return Object.assign(
    new Error("The operation was aborted", {
      cause: signal.reason,
    }),
    {
      name: "AbortError",
      code: "ABORT_ERR",
    },
  );
}

function options(value: unknown): TimerOptions {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object") {
    throw invalidArgType("options", "of type object", value);
  }
  const signal = (value as TimerOptions).signal;
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== "object" || !("aborted" in signal))
  ) {
    throw invalidArgType("options.signal", "an instance of AbortSignal", signal);
  }
  return value as TimerOptions;
}

function settleLater<T>(
  schedule: (resolve: () => void) => { clear(): void },
  value: T,
  rawOptions: unknown,
): Promise<T> {
  let parsed: TimerOptions;
  try {
    parsed = options(rawOptions);
  } catch (error) {
    return Promise.reject(error);
  }
  const { signal } = parsed;
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      timer.clear();
      reject(abortError(signal!));
    };
    const timer = schedule(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    });
    signal?.addEventListener("abort", onAbort, {
      once: true,
    });
  });
}

export function setTimeout<T = void>(delay?: number, value?: T, rawOptions?: unknown): Promise<T> {
  return settleLater((resolve) => timeout(resolve, delay), value as T, rawOptions);
}

export function setImmediate<T = void>(value?: T, rawOptions?: unknown): Promise<T> {
  return settleLater((resolve) => immediate(resolve), value as T, rawOptions);
}

/** Yields `value` once per interval until the iterator returns or the signal aborts. */
export function setInterval<T = void>(
  delay?: number,
  value?: T,
  rawOptions?: unknown,
): AsyncIterableIterator<T> {
  const { signal } = options(rawOptions);
  let pending = 0;
  let waiting: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let done = false;
  const timer = interval(() => {
    if (waiting) {
      const current = waiting;
      waiting = null;
      current.resolve({
        value: value as T,
        done: false,
      });
    } else {
      pending += 1;
    }
  }, delay);
  const finish = () => {
    done = true;
    clearInterval(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    finish();
    if (waiting) {
      waiting.reject(abortError(signal!));
      waiting = null;
    }
  };
  signal?.addEventListener("abort", onAbort, {
    once: true,
  });
  const iterator: AsyncIterableIterator<T> = {
    next() {
      if (signal?.aborted) {
        finish();
        return Promise.reject(abortError(signal));
      }
      if (pending > 0) {
        pending -= 1;
        return Promise.resolve({
          value: value as T,
          done: false,
        });
      }
      if (done) {
        return Promise.resolve({
          value: undefined,
          done: true,
        });
      }
      return new Promise((resolve, reject) => {
        waiting = {
          resolve,
          reject,
        };
      });
    },
    return() {
      finish();
      return Promise.resolve({
        value: undefined,
        done: true,
      });
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

export const scheduler = {
  wait: (delay: number, rawOptions?: unknown) => setTimeout(delay, undefined, rawOptions),
  yield: () => setImmediate(),
};

export default {
  setTimeout,
  setImmediate,
  setInterval,
  scheduler,
};
