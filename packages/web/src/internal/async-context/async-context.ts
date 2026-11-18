// Async context over the engine's slot, after the TC39 AsyncContext proposal
// (https://github.com/tc39/proposal-async-context): Variable and Snapshot
// over one mapping from variables to values. The engine keeps the current
// mapping and carries it through promise reactions; host task sources run
// their callbacks in a Snapshot taken when they were scheduled.
//
// The slot is `__fetchletAsyncContext`, `{ get(), set(mapping) }`, which an
// engine installs before the bundle runs. Without it the mapping is a plain
// variable: `run` still scopes synchronous code, but nothing propagates
// through `await`, so `propagates` tells whether an engine supports it.

import { runtime } from "../runtime/runtime";

type Mapping = ReadonlyMap<object, unknown>;

interface Slot {
  get(): unknown;
  set(mapping: unknown): void;
}

const empty: Mapping = new Map();

const slot: Slot = (() => {
  const host = runtime.__fetchletAsyncContext as Slot | undefined;
  if (host && typeof host.get === "function" && typeof host.set === "function") {
    return host;
  }
  let mapping: unknown;
  return {
    get: () => mapping,
    set: (value) => {
      mapping = value;
    },
  };
})();

/** Whether the engine carries the context through promise reactions. */
export const propagates = runtime.__fetchletAsyncContext !== undefined;

/** The current mapping. Mappings are never modified once current. */
function current(): Mapping {
  const mapping = slot.get();
  return mapping instanceof Map ? mapping : empty;
}

/** Calls `callback` with `mapping` current, then restores the previous one. */
function runIn<Args extends unknown[], Result>(
  mapping: Mapping,
  callback: (...args: Args) => Result,
  args: Args,
): Result {
  const previous = slot.get();
  slot.set(mapping);
  try {
    return callback(...args);
  } finally {
    slot.set(previous);
  }
}

function withValue(mapping: Mapping, variable: object, value: unknown): Mapping {
  const next = new Map(mapping);
  next.set(variable, value);
  return next;
}

export class Variable<T> {
  readonly #name: string;
  readonly #defaultValue: T | undefined;

  constructor(options?: { name?: unknown; defaultValue?: T }) {
    // eslint-disable-next-line typescript/no-base-to-string -- the proposal converts the name with ToString.
    this.#name = options?.name === undefined ? "" : String(options.name);
    this.#defaultValue = options?.defaultValue;
  }

  get name(): string {
    return this.#name;
  }

  /** The value in the current mapping, or the default value if it has none. */
  get(): T | undefined {
    const mapping = current();
    return mapping.has(this) ? (mapping.get(this) as T) : this.#defaultValue;
  }

  run<Args extends unknown[], Result>(
    value: T,
    callback: (...args: Args) => Result,
    ...args: Args
  ): Result {
    return runIn(withValue(current(), this, value), callback, args);
  }
}

export class Snapshot {
  readonly #mapping: Mapping = current();

  run<Args extends unknown[], Result>(callback: (...args: Args) => Result, ...args: Args): Result {
    return runIn(this.#mapping, callback, args);
  }

  /** `callback` bound to the current mapping, as AsyncContext.Snapshot.wrap. */
  static wrap<This, Args extends unknown[], Result>(
    callback: (this: This, ...args: Args) => Result,
  ): (this: This, ...args: Args) => Result {
    const snapshot = new Snapshot();
    return function (this: This, ...args: Args) {
      return snapshot.run(() => callback.apply(this, args));
    };
  }
}

/**
 * Makes `value` the variable's value in the current mapping until the
 * current task or promise job ends, or the enclosing `run` returns. Backs
 * AsyncLocalStorage's enterWith and disable.
 */
export function enter(variable: Variable<unknown>, value: unknown) {
  slot.set(withValue(current(), variable, value));
}

/** Removes the variable from the current mapping, as enter() scopes it. */
export function leave(variable: Variable<unknown>) {
  const mapping = current();
  if (mapping.has(variable)) {
    const next = new Map(mapping);
    next.delete(variable);
    slot.set(next);
  }
}
