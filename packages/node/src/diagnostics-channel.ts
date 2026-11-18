// node:diagnostics_channel: named channels that libraries publish to and
// tools subscribe to, with Node's TracingChannel and store bindings.

import { invalidArgType, validateFunction } from "./errors.ts";

type Subscriber = (message: unknown, name: string | symbol) => void;

interface Store {
  run<T>(store: unknown, callback: (...args: unknown[]) => T, ...args: unknown[]): T;
}

/** Throws a subscriber's error later, as Node does, so publishing continues. */
function reportLater(error: unknown) {
  queueMicrotask(() => {
    throw error;
  });
}

export class Channel {
  readonly name: string | symbol;
  #subscribers: Subscriber[] = [];
  #stores = new Map<Store, ((message: unknown) => unknown) | undefined>();

  constructor(name: string | symbol) {
    if (typeof name !== "string" && typeof name !== "symbol") {
      throw invalidArgType("channel", "of type string or symbol", name);
    }
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return this.#subscribers.length > 0 || this.#stores.size > 0;
  }

  subscribe(subscription: Subscriber): void {
    validateFunction(subscription, "subscription");
    this.#subscribers = [...this.#subscribers, subscription];
  }

  unsubscribe(subscription: Subscriber): boolean {
    const index = this.#subscribers.indexOf(subscription);
    if (index === -1) {
      return false;
    }
    this.#subscribers = this.#subscribers.filter((_, position) => position !== index);
    return true;
  }

  bindStore(store: Store, transform?: (message: unknown) => unknown): void {
    this.#stores.set(store, transform);
  }

  unbindStore(store: Store): boolean {
    return this.#stores.delete(store);
  }

  publish(message: unknown): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(message, this.name);
      } catch (error) {
        reportLater(error);
      }
    }
  }

  runStores<T>(
    data: unknown,
    fn: (...args: unknown[]) => T,
    thisArg?: unknown,
    ...args: unknown[]
  ): T {
    let run = () => {
      this.publish(data);
      return fn.apply(thisArg, args);
    };
    for (const [store, transform] of this.#stores) {
      const next = run;
      let value = data;
      if (transform) {
        try {
          value = transform(data);
        } catch (error) {
          reportLater(error);
          continue;
        }
      }
      run = () => store.run(value, next);
    }
    return run();
  }
}

const channels = new Map<string | symbol, Channel>();

export function channel(name: string | symbol): Channel {
  let existing = channels.get(name);
  if (!existing) {
    existing = new Channel(name);
    channels.set(name, existing);
  }
  return existing;
}

export function hasSubscribers(name: string | symbol): boolean {
  return channels.get(name)?.hasSubscribers ?? false;
}

export function subscribe(name: string | symbol, subscription: Subscriber): void {
  channel(name).subscribe(subscription);
}

export function unsubscribe(name: string | symbol, subscription: Subscriber): boolean {
  return channels.get(name)?.unsubscribe(subscription) ?? false;
}

const traceEvents = ["start", "end", "asyncStart", "asyncEnd", "error"] as const;
type TraceEvent = (typeof traceEvents)[number];
type TraceHandlers = Partial<Record<TraceEvent, Subscriber>>;

export class TracingChannel {
  start!: Channel;
  end!: Channel;
  asyncStart!: Channel;
  asyncEnd!: Channel;
  error!: Channel;

  constructor(nameOrChannels: string | Partial<Record<TraceEvent, Channel>>) {
    for (const event of traceEvents) {
      if (typeof nameOrChannels === "string") {
        this[event] = channel(`tracing:${nameOrChannels}:${event}`);
      } else if (nameOrChannels !== null && typeof nameOrChannels === "object") {
        const given = nameOrChannels[event];
        if (!(given instanceof Channel)) {
          throw invalidArgType(`nameOrChannels.${event}`, "an instance of Channel", given);
        }
        this[event] = given;
      } else {
        throw invalidArgType(
          "nameOrChannels",
          "of type string or an instance of TracingChannel or Object",
          nameOrChannels,
        );
      }
    }
  }

  get hasSubscribers(): boolean {
    return traceEvents.some((event) => this[event].hasSubscribers);
  }

  subscribe(handlers: TraceHandlers): void {
    for (const event of traceEvents) {
      const handler = handlers[event];
      if (handler) {
        this[event].subscribe(handler);
      }
    }
  }

  unsubscribe(handlers: TraceHandlers): boolean {
    let done = true;
    for (const event of traceEvents) {
      const handler = handlers[event];
      if (handler && !this[event].unsubscribe(handler)) {
        done = false;
      }
    }
    return done;
  }

  traceSync<T>(
    fn: (...args: unknown[]) => T,
    context: Record<string, unknown> = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): T {
    if (!this.hasSubscribers) {
      return fn.apply(thisArg, args);
    }
    return this.start.runStores(context, () => {
      try {
        const result = fn.apply(thisArg, args);
        context.result = result;
        return result;
      } catch (error) {
        context.error = error;
        this.error.publish(context);
        throw error;
      } finally {
        this.end.publish(context);
      }
    });
  }

  tracePromise<T>(
    fn: (...args: unknown[]) => Promise<T>,
    context: Record<string, unknown> = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): Promise<T> {
    if (!this.hasSubscribers) {
      return fn.apply(thisArg, args);
    }
    const resolve = (result: T) => {
      context.result = result;
      this.asyncStart.publish(context);
      this.asyncEnd.publish(context);
      return result;
    };
    const reject = (error: unknown) => {
      context.error = error;
      this.error.publish(context);
      this.asyncStart.publish(context);
      this.asyncEnd.publish(context);
      throw error;
    };
    return this.start.runStores(context, () => {
      try {
        return Promise.resolve(fn.apply(thisArg, args)).then(resolve, reject);
      } catch (error) {
        context.error = error;
        this.error.publish(context);
        throw error;
      } finally {
        this.end.publish(context);
      }
    });
  }

  traceCallback<T>(
    fn: (...args: unknown[]) => T,
    position = -1,
    context: Record<string, unknown> = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): T {
    if (!this.hasSubscribers) {
      return fn.apply(thisArg, args);
    }
    const index = position < 0 ? args.length + position : position;
    const callback = args[index] as (error: unknown, result?: unknown) => unknown;
    validateFunction(callback, "callback");
    args[index] = (error: unknown, result: unknown) => {
      if (error) {
        context.error = error;
        this.error.publish(context);
      } else {
        context.result = result;
      }
      return this.asyncStart.runStores(context, () => {
        try {
          return callback.call(thisArg, error, result);
        } finally {
          this.asyncEnd.publish(context);
        }
      });
    };
    return this.start.runStores(context, () => {
      try {
        return fn.apply(thisArg, args);
      } catch (error) {
        context.error = error;
        this.error.publish(context);
        throw error;
      } finally {
        this.end.publish(context);
      }
    });
  }
}

export function tracingChannel(
  nameOrChannels: string | Partial<Record<TraceEvent, Channel>>,
): TracingChannel {
  return new TracingChannel(nameOrChannels);
}

export default {
  Channel,
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
};
