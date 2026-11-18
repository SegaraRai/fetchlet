// node:async_hooks for engines that propagate async context (V8 and Boa):
// AsyncLocalStorage and AsyncResource over @fetchlet/web's AsyncContext
// Variable and Snapshot, as Node implements them over AsyncContextFrame.
// Each storage is a variable, so concurrent runs inside one invocation keep
// their own stores across await, timers and messages.
//
// enterWith and disable follow Node. Cloudflare Workers omits both; code
// written for Workers does not call them.

import { Snapshot, Variable, enter, leave, propagates } from "@fetchlet/web/async-context";

if (!propagates) {
  throw new Error(
    'This engine does not propagate async context; build with asyncContext: "serialized"',
  );
}

type Callback<Args extends unknown[], Result> = (...args: Args) => Result;

export class AsyncLocalStorage<Store> {
  readonly #variable: Variable<Store>;

  constructor(options?: { defaultValue?: Store; name?: string }) {
    this.#variable = new Variable<Store>({
      name: options?.name,
      defaultValue: options?.defaultValue,
    });
  }

  get name(): string {
    return this.#variable.name;
  }

  /** A function that runs a callback in the context current now. */
  static snapshot(): <Args extends unknown[], Result>(
    callback: Callback<Args, Result>,
    ...args: Args
  ) => Result {
    const snapshot = new Snapshot();
    return (callback, ...args) => snapshot.run(callback, ...args);
  }

  static bind<Args extends unknown[], Result>(
    callback: Callback<Args, Result>,
  ): Callback<Args, Result> {
    return Snapshot.wrap(callback);
  }

  getStore(): Store | undefined {
    return this.#variable.get();
  }

  run<Args extends unknown[], Result>(
    store: Store,
    callback: Callback<Args, Result>,
    ...args: Args
  ): Result {
    return this.#variable.run(store, callback, ...args);
  }

  exit<Args extends unknown[], Result>(callback: Callback<Args, Result>, ...args: Args): Result {
    return this.#variable.run(undefined as Store, callback, ...args);
  }

  /**
   * Sets the store for the rest of the current task or promise job, and for
   * the work it schedules, until the enclosing run returns.
   */
  enterWith(store: Store): void {
    enter(this.#variable as Variable<unknown>, store);
  }

  /** Unsets the store in the current context until the next run or enterWith. */
  disable(): void {
    leave(this.#variable as Variable<unknown>);
  }
}

let nextAsyncId = 1;

/**
 * A callback scope bound to the context of its creation, for libraries
 * that carry context into callbacks they call later.
 */
export class AsyncResource {
  readonly #snapshot = new Snapshot();
  readonly #asyncId = nextAsyncId++;
  readonly #triggerAsyncId: number;

  constructor(_type: string, options?: { triggerAsyncId?: number } | number) {
    this.#triggerAsyncId = typeof options === "number" ? options : (options?.triggerAsyncId ?? 0);
  }

  static bind<Args extends unknown[], Result, This>(
    callback: (this: This, ...args: Args) => Result,
    type?: string,
    thisArg?: This,
  ): (...args: Args) => Result {
    return new AsyncResource(type ?? (callback.name || "bound-anonymous-fn")).bind(
      callback,
      thisArg,
    );
  }

  runInAsyncScope<Args extends unknown[], Result, This>(
    callback: (this: This, ...args: Args) => Result,
    thisArg?: This,
    ...args: Args
  ): Result {
    return this.#snapshot.run(() => callback.apply(thisArg as This, args));
  }

  bind<Args extends unknown[], Result, This>(
    callback: (this: This, ...args: Args) => Result,
    thisArg?: This,
  ): (...args: Args) => Result {
    const resource = this;
    if (thisArg !== undefined) {
      return (...args: Args) => resource.runInAsyncScope(callback, thisArg, ...args);
    }
    return function (this: This, ...args: Args) {
      return resource.runInAsyncScope(callback, this, ...args);
    };
  }

  emitDestroy(): this {
    return this;
  }

  asyncId(): number {
    return this.#asyncId;
  }

  triggerAsyncId(): number {
    return this.#triggerAsyncId;
  }
}
