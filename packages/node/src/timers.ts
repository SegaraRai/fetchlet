// node:timers, setImmediate and clearImmediate over the profile's timers.
// Node's timer functions return Timeout and Immediate objects with ref,
// unref, hasRef and refresh; an instance's event loop ends with its
// invocation, so ref and unref change nothing but are kept for callers that
// chain them. Immediates run as zero-delay timers.

import { validateFunction } from "./errors.ts";

// The profile's timers return numeric ids. Hosts whose timers return objects,
// such as Node running the tests, get ids from a counter instead.
type Handle = number | object;

const runtime = globalThis as unknown as {
  setTimeout(callback: () => void, delay?: number): Handle;
  setInterval(callback: () => void, delay?: number): Handle;
  clearTimeout(handle?: Handle): void;
  clearInterval(handle?: Handle): void;
};

let nextId = 1;

function idOf(handle: Handle): number {
  return typeof handle === "number" ? handle : nextId++;
}

class Timer {
  #handle: Handle;
  #id: number;
  #referenced = true;
  #schedule: () => Handle;
  #repeat: boolean;
  #cleared = false;

  constructor(schedule: () => Handle, repeat: boolean) {
    this.#schedule = schedule;
    this.#repeat = repeat;
    this.#handle = schedule();
    this.#id = idOf(this.#handle);
  }

  ref(): this {
    this.#referenced = true;
    return this;
  }

  unref(): this {
    this.#referenced = false;
    return this;
  }

  hasRef(): boolean {
    return this.#referenced;
  }

  /** Restarts the timer with its original delay. */
  refresh(): this {
    if (!this.#cleared) {
      this.#clearHandle();
      this.#handle = this.#schedule();
    }
    return this;
  }

  close(): this {
    this.clear();
    return this;
  }

  clear() {
    this.#cleared = true;
    this.#clearHandle();
  }

  #clearHandle() {
    if (this.#repeat) {
      runtime.clearInterval(this.#handle);
    } else {
      runtime.clearTimeout(this.#handle);
    }
  }

  [Symbol.toPrimitive](): number {
    return this.#id;
  }
}

export class Timeout extends Timer {
  get [Symbol.toStringTag]() {
    return "Timeout";
  }
}

export class Immediate extends Timer {
  get [Symbol.toStringTag]() {
    return "Immediate";
  }
}

const timersById = new Map<number, Timer>();

function track<T extends Timer>(timer: T): T {
  timersById.set(+timer, timer);
  return timer;
}

function clear(timer: unknown) {
  if (timer instanceof Timer) {
    timersById.delete(+timer);
    timer.clear();
    return;
  }
  if (typeof timer === "number" || typeof timer === "string") {
    const id = Number(timer);
    const found = timersById.get(id);
    if (found) {
      timersById.delete(id);
      found.clear();
    } else {
      runtime.clearTimeout(id);
    }
  }
}

export function setTimeout<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay?: number,
  ...args: Args
): Timeout {
  validateFunction(callback, "callback");
  let timeout: Timeout;
  timeout = track(
    new Timeout(
      () =>
        runtime.setTimeout(() => {
          timersById.delete(+timeout);
          callback(...args);
        }, delay),
      false,
    ),
  );
  return timeout;
}

export function setInterval<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay?: number,
  ...args: Args
): Timeout {
  validateFunction(callback, "callback");
  return track(new Timeout(() => runtime.setInterval(() => callback(...args), delay), true));
}

export function setImmediate<Args extends unknown[]>(
  callback: (...args: Args) => void,
  ...args: Args
): Immediate {
  validateFunction(callback, "callback");
  let immediate: Immediate;
  immediate = track(
    new Immediate(
      () =>
        runtime.setTimeout(() => {
          timersById.delete(+immediate);
          callback(...args);
        }, 0),
      false,
    ),
  );
  return immediate;
}

export const clearTimeout = clear;
export const clearInterval = clear;
export const clearImmediate = clear;

export default {
  setTimeout,
  setInterval,
  setImmediate,
  clearTimeout,
  clearInterval,
  clearImmediate,
  Timeout,
  Immediate,
};
