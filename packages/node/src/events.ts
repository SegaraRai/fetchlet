// node:events: EventEmitter with Node's listener order, `newListener` and
// `removeListener` events, `error` handling, errorMonitor and max-listener
// warnings, and the module's once, on, getEventListeners, setMaxListeners and
// addAbortListener helpers.

import { invalidArgType, nodeError, validateFunction, validateInteger } from "./errors.ts";
import { emitWarning } from "./warnings.ts";

type Listener = (...args: any[]) => unknown;
type EventName = string | symbol;

/** A once listener keeps its original function for rawListeners and removal. */
interface OnceWrapper extends Listener {
  listener: Listener;
}

export const errorMonitor: unique symbol = Symbol("events.errorMonitor");
export const captureRejectionSymbol: unique symbol = Symbol.for("nodejs.rejection");

let defaultMaxListeners = 10;

const events = new WeakMap<object, Map<EventName, Listener[]>>();
const maxListeners = new WeakMap<object, number>();
const warned = new WeakMap<object, Set<EventName>>();

function table(emitter: object): Map<EventName, Listener[]> {
  let found = events.get(emitter);
  if (!found) {
    found = new Map();
    events.set(emitter, found);
  }
  return found;
}

function warn(emitter: object, type: EventName, count: number) {
  let types = warned.get(emitter);
  if (!types) {
    types = new Set();
    warned.set(emitter, types);
  }
  if (types.has(type)) {
    return;
  }
  types.add(type);
  const name = (emitter as { constructor?: { name?: string } }).constructor?.name ?? "EventEmitter";
  const warning = Object.assign(
    new Error(
      `Possible ${name} memory leak detected. ${count} ${String(type)} listeners added to [${name}]. ` +
        "MaxListeners is " +
        getMaxListeners(emitter) +
        ". Use emitter.setMaxListeners() to increase limit",
    ),
    {
      name: "MaxListenersExceededWarning",
      emitter,
      type,
      count,
    },
  );
  emitWarning(warning);
}

function getMaxListeners(emitter: object): number {
  return maxListeners.get(emitter) ?? defaultMaxListeners;
}

function addListener(
  emitter: EventEmitter,
  type: EventName,
  listener: Listener,
  prepend: boolean,
): EventEmitter {
  validateFunction(listener, "listener");
  const listeners = table(emitter);
  if (listeners.has("newListener")) {
    emitter.emit("newListener", type, (listener as OnceWrapper).listener ?? listener);
  }
  let list = listeners.get(type);
  if (!list) {
    list = [];
    listeners.set(type, list);
  }
  if (prepend) {
    list.unshift(listener);
  } else {
    list.push(listener);
  }
  const max = getMaxListeners(emitter);
  if (max > 0 && list.length > max) {
    warn(emitter, type, list.length);
  }
  return emitter;
}

function onceWrapper(emitter: EventEmitter, type: EventName, listener: Listener): OnceWrapper {
  let fired = false;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    if (!fired) {
      fired = true;
      emitter.removeListener(type, wrapper);
      return listener.apply(this, args);
    }
  } as OnceWrapper;
  wrapper.listener = listener;
  return wrapper;
}

class EventEmitterClass {
  static EventEmitter: typeof EventEmitter;
  static errorMonitor = errorMonitor;
  static captureRejectionSymbol = captureRejectionSymbol;
  static captureRejections = false;
  static once: typeof once;
  static on: typeof on;
  static getEventListeners: typeof getEventListeners;
  static getMaxListeners: typeof getMaxListenersOf;
  static setMaxListeners: typeof setMaxListeners;
  static addAbortListener: typeof addAbortListener;
  static listenerCount: typeof listenerCount;

  static get defaultMaxListeners(): number {
    return defaultMaxListeners;
  }

  static set defaultMaxListeners(value: number) {
    if (typeof value !== "number" || value < 0 || Number.isNaN(value)) {
      throw nodeError(
        RangeError,
        "ERR_OUT_OF_RANGE",
        `The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ${String(value)}`,
      );
    }
    defaultMaxListeners = value;
  }

  // Node's constructor accepts options such as captureRejections, which
  // fetchlet does not implement.
  constructor(_options?: { captureRejections?: boolean }) {
    table(this);
  }

  setMaxListeners(count: number): this {
    if (typeof count !== "number" || count < 0 || Number.isNaN(count)) {
      throw nodeError(
        RangeError,
        "ERR_OUT_OF_RANGE",
        `The value of "n" is out of range. It must be a non-negative number. Received ${String(count)}`,
      );
    }
    maxListeners.set(this, count);
    return this;
  }

  getMaxListeners(): number {
    return getMaxListeners(this);
  }

  emit(type: EventName, ...args: unknown[]): boolean {
    const listeners = table(this);
    if (type === "error") {
      const monitors = listeners.get(errorMonitor);
      if (monitors) {
        for (const monitor of [...monitors]) {
          monitor.apply(this, args);
        }
      }
    }
    const list = listeners.get(type);
    if (!list || list.length === 0) {
      if (type === "error") {
        const error = args[0];
        if (error instanceof Error) {
          throw error;
        }
        throw nodeError(
          Error,
          "ERR_UNHANDLED_ERROR",
          `Unhandled error.${error === undefined ? "" : ` (${String(error)})`}`,
        );
      }
      return false;
    }
    for (const listener of [...list]) {
      listener.apply(this, args);
    }
    return true;
  }

  addListener(type: EventName, listener: Listener): this {
    return addListener(this, type, listener, false) as this;
  }

  on(type: EventName, listener: Listener): this {
    return addListener(this, type, listener, false) as this;
  }

  prependListener(type: EventName, listener: Listener): this {
    return addListener(this, type, listener, true) as this;
  }

  once(type: EventName, listener: Listener): this {
    validateFunction(listener, "listener");
    return addListener(this, type, onceWrapper(this, type, listener), false) as this;
  }

  prependOnceListener(type: EventName, listener: Listener): this {
    validateFunction(listener, "listener");
    return addListener(this, type, onceWrapper(this, type, listener), true) as this;
  }

  removeListener(type: EventName, listener: Listener): this {
    validateFunction(listener, "listener");
    const listeners = table(this);
    const list = listeners.get(type);
    if (!list) {
      return this;
    }
    // The most recently added match goes first, as in Node.
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const candidate = list[index];
      if (candidate === listener || (candidate as OnceWrapper).listener === listener) {
        list.splice(index, 1);
        if (list.length === 0) {
          listeners.delete(type);
        }
        if (listeners.has("removeListener")) {
          this.emit("removeListener", type, (candidate as OnceWrapper).listener ?? candidate);
        }
        break;
      }
    }
    return this;
  }

  off(type: EventName, listener: Listener): this {
    return this.removeListener(type, listener);
  }

  removeAllListeners(type?: EventName): this {
    const listeners = table(this);
    if (type === undefined) {
      for (const name of [...listeners.keys()]) {
        if (name !== "removeListener") {
          this.removeAllListeners(name);
        }
      }
      this.removeAllListeners("removeListener");
      return this;
    }
    const list = listeners.get(type);
    if (!list) {
      return this;
    }
    if (listeners.has("removeListener") && type !== "removeListener") {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        this.removeListener(type, list[index]);
      }
    }
    listeners.delete(type);
    return this;
  }

  listeners(type: EventName): Listener[] {
    return (table(this).get(type) ?? []).map(
      (listener) => (listener as OnceWrapper).listener ?? listener,
    );
  }

  rawListeners(type: EventName): Listener[] {
    return [...(table(this).get(type) ?? [])];
  }

  listenerCount(type: EventName, listener?: Listener): number {
    const list = table(this).get(type) ?? [];
    if (listener === undefined) {
      return list.length;
    }
    return list.filter(
      (candidate) => candidate === listener || (candidate as OnceWrapper).listener === listener,
    ).length;
  }

  eventNames(): EventName[] {
    return [...table(this).keys()];
  }
}

/**
 * EventEmitter as Node defines it: a function, so that older libraries can
 * initialize their subclasses with EventEmitter.call(this), which a class
 * does not allow. It shares the class's prototype and static members.
 */
export const EventEmitter = function EventEmitter(
  this: object,
  _options?: { captureRejections?: boolean },
) {
  table(this);
} as unknown as typeof EventEmitterClass;
export type EventEmitter = EventEmitterClass;

for (const key of Reflect.ownKeys(EventEmitterClass)) {
  if (key !== "prototype" && key !== "length" && key !== "name") {
    Object.defineProperty(
      EventEmitter,
      key,
      Object.getOwnPropertyDescriptor(EventEmitterClass, key)!,
    );
  }
}
EventEmitter.prototype = EventEmitterClass.prototype;
Object.defineProperty(EventEmitterClass.prototype, "constructor", {
  value: EventEmitter,
  writable: true,
  configurable: true,
});
EventEmitter.EventEmitter = EventEmitter;

interface EventTargetLike {
  addEventListener(type: string, listener: Listener, options?: object): void;
  removeEventListener(type: string, listener: Listener, options?: object): void;
}

function isEventTarget(value: unknown): value is EventTargetLike {
  return typeof (value as EventTargetLike)?.addEventListener === "function";
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

function validateSignal(signal: unknown): asserts signal is AbortSignal | undefined {
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== "object" || !("aborted" in signal))
  ) {
    throw invalidArgType("options.signal", "an instance of AbortSignal", signal);
  }
}

/** Resolves with the arguments of the next `name` event, or rejects on `error`. */
export function once(
  emitter: EventEmitter | EventTargetLike,
  name: EventName,
  options: { signal?: AbortSignal } = {},
): Promise<unknown[]> {
  const signal = options?.signal;
  validateSignal(signal);
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const cleanups: Array<() => void> = [];
    const finish = () => {
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
    };
    if (isEventTarget(emitter) && !(emitter instanceof EventEmitter)) {
      const listener = (...args: unknown[]) => {
        finish();
        resolve(args);
      };
      emitter.addEventListener(String(name), listener, { once: true });
      cleanups.push(() => emitter.removeEventListener(String(name), listener));
    } else {
      const target = emitter as EventEmitter;
      const listener = (...args: unknown[]) => {
        finish();
        resolve(args);
      };
      target.on(name, listener);
      cleanups.push(() => target.removeListener(name, listener));
      if (name !== "error") {
        const onError = (error: unknown) => {
          finish();
          reject(error);
        };
        target.on("error", onError);
        cleanups.push(() => target.removeListener("error", onError));
      }
    }
    if (signal) {
      const onAbort = () => {
        finish();
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
  });
}

/** An async iterator over the arguments of each `name` event, until `error` or abort. */
export function on(
  emitter: EventEmitter | EventTargetLike,
  name: EventName,
  options: { signal?: AbortSignal; close?: EventName[] } = {},
): AsyncIterableIterator<unknown[]> {
  const signal = options?.signal;
  validateSignal(signal);
  if (signal?.aborted) {
    throw abortError(signal);
  }
  const queued: unknown[][] = [];
  const waiting: Array<{
    resolve: (result: IteratorResult<unknown[]>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let failure: unknown;
  let failed = false;
  let finished = false;
  const cleanups: Array<() => void> = [];
  const close = () => {
    finished = true;
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    for (const waiter of waiting.splice(0)) {
      waiter.resolve({
        value: undefined,
        done: true,
      });
    }
  };
  const fail = (error: unknown) => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    finished = true;
    const waiter = waiting.shift();
    if (waiter) {
      waiter.reject(error);
    } else {
      failed = true;
      failure = error;
    }
  };
  const push = (...args: unknown[]) => {
    const waiter = waiting.shift();
    if (waiter) {
      waiter.resolve({
        value: args,
        done: false,
      });
    } else {
      queued.push(args);
    }
  };
  if (isEventTarget(emitter) && !(emitter instanceof EventEmitter)) {
    emitter.addEventListener(String(name), push);
    cleanups.push(() => emitter.removeEventListener(String(name), push));
  } else {
    const target = emitter as EventEmitter;
    target.on(name, push);
    cleanups.push(() => target.removeListener(name, push));
    if (name !== "error") {
      target.on("error", fail);
      cleanups.push(() => target.removeListener("error", fail));
    }
    for (const closing of options?.close ?? []) {
      target.on(closing, close);
      cleanups.push(() => target.removeListener(closing, close));
    }
  }
  if (signal) {
    const onAbort = () => fail(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }
  const iterator: AsyncIterableIterator<unknown[]> = {
    next() {
      if (queued.length > 0) {
        return Promise.resolve({
          value: queued.shift()!,
          done: false,
        });
      }
      if (failed) {
        failed = false;
        const error = failure;
        failure = undefined;
        return Promise.reject(error);
      }
      if (finished) {
        return Promise.resolve({
          value: undefined,
          done: true,
        });
      }
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    return() {
      close();
      return Promise.resolve({
        value: undefined,
        done: true,
      });
    },
    throw(error: unknown) {
      fail(error);
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

export function getEventListeners(target: EventEmitter | object, name: EventName): Listener[] {
  if (target instanceof EventEmitter) {
    return target.listeners(name);
  }
  throw invalidArgType("emitter", "an instance of EventEmitter", target);
}

function getMaxListenersOf(target: EventEmitter): number {
  return target.getMaxListeners();
}

export { getMaxListenersOf as getMaxListeners };

export function setMaxListeners(count = defaultMaxListeners, ...targets: EventEmitter[]) {
  validateInteger(count, "n", 0);
  if (targets.length === 0) {
    defaultMaxListeners = count;
    return;
  }
  for (const target of targets) {
    if (target instanceof EventEmitter) {
      target.setMaxListeners(count);
    }
  }
}

export function listenerCount(emitter: EventEmitter, name: EventName): number {
  return emitter.listenerCount(name);
}

/** Calls `listener` once the signal aborts; the result removes it. */
export function addAbortListener(signal: AbortSignal, listener: (event: Event) => void) {
  validateSignal(signal);
  validateFunction(listener, "listener");
  if (signal.aborted) {
    queueMicrotask(() => listener(new Event("abort")));
    return {
      [Symbol.dispose ?? Symbol.for("nodejs.dispose")]() {},
    };
  }
  signal.addEventListener("abort", listener, {
    once: true,
  });
  return {
    [Symbol.dispose ?? Symbol.for("nodejs.dispose")]() {
      signal.removeEventListener("abort", listener);
    },
  };
}

EventEmitter.once = once;
EventEmitter.on = on;
EventEmitter.getEventListeners = getEventListeners;
EventEmitter.getMaxListeners = getMaxListenersOf;
EventEmitter.setMaxListeners = setMaxListeners;
EventEmitter.addAbortListener = addAbortListener;
EventEmitter.listenerCount = listenerCount;

export { defaultMaxListeners };

// require("events") is the EventEmitter class, which carries the helpers.
export default EventEmitter;
