// Error reporting on the global scope (HTML §8.1.4.5 and §8.1.4.7): the
// global object is an EventTarget, reportError and exceptions from tasks
// dispatch an ErrorEvent, and promise rejections that stay unhandled through
// a microtask checkpoint dispatch PromiseRejectionEvents.
//
// The engine reports rejections through `__fetchletPromiseRejection`, from
// its HostPromiseRejectionTracker, and calls `__fetchletFlushRejections`
// after each microtask checkpoint of the host event loop.

import { Snapshot } from "../async-context/async-context";
import {
  EventImpl,
  EventTargetImpl,
  adoptEventTarget,
  defineEventHandler,
  dispatchTrusted,
} from "../dom/events";
import { runtime } from "../runtime/runtime";
import { dictionary, domString, exposeAttributes } from "../webidl/idl";

interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

/** Web IDL unsigned long. */
function unsignedLong(value: unknown): number {
  const number = +(value as number);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return ((Math.trunc(number) % 2 ** 32) + 2 ** 32) % 2 ** 32;
}

class ErrorEventImpl extends EventImpl {
  readonly #message: string;
  readonly #filename: string;
  readonly #lineno: number;
  readonly #colno: number;
  readonly #error: unknown;

  constructor(
    type: string,
    init?: EventInit & {
      message?: string;
      filename?: string;
      lineno?: number;
      colno?: number;
      error?: unknown;
    },
  ) {
    if (arguments.length < 1) {
      throw new TypeError("ErrorEvent requires a type");
    }
    const options = dictionary(init);
    super(type, options);
    this.#message = options.message === undefined ? "" : domString(options.message);
    this.#filename = options.filename === undefined ? "" : domString(options.filename);
    this.#lineno = unsignedLong(options.lineno);
    this.#colno = unsignedLong(options.colno);
    this.#error = options.error;
  }

  get message() {
    return this.#message;
  }

  get filename() {
    return this.#filename;
  }

  get lineno() {
    return this.#lineno;
  }

  get colno() {
    return this.#colno;
  }

  get error() {
    return this.#error;
  }

  get [Symbol.toStringTag]() {
    return "ErrorEvent";
  }
}

class PromiseRejectionEventImpl extends EventImpl {
  readonly #promise: object;
  readonly #reason: unknown;

  constructor(type: string, init: EventInit & { promise: object; reason?: unknown }) {
    if (arguments.length < 2) {
      throw new TypeError("PromiseRejectionEvent requires a type and an init dictionary");
    }
    const options = dictionary(init);
    const promise = options.promise;
    if (promise === null || (typeof promise !== "object" && typeof promise !== "function")) {
      throw new TypeError("PromiseRejectionEvent requires a promise object");
    }
    super(type, options);
    this.#promise = promise;
    this.#reason = options.reason;
  }

  get promise() {
    return this.#promise;
  }

  get reason() {
    return this.#reason;
  }

  get [Symbol.toStringTag]() {
    return "PromiseRejectionEvent";
  }
}

exposeAttributes(ErrorEventImpl.prototype, ["message", "filename", "lineno", "colno", "error"]);
exposeAttributes(PromiseRejectionEventImpl.prototype, ["promise", "reason"]);

Object.defineProperty(ErrorEventImpl, "name", {
  value: "ErrorEvent",
});
Object.defineProperty(PromiseRejectionEventImpl, "name", {
  value: "PromiseRejectionEvent",
});

/**
 * Whether this profile makes the global scope an event target: it does
 * unless the engine already has. The global scope uses this profile's
 * EventTarget methods, so events dispatched on it are this profile's events.
 */
const globalEvents = typeof runtime.addEventListener !== "function";

if (globalEvents) {
  // The events the global scope dispatches are instances of the global
  // constructors, so these replace any the engine has without the scope.
  runtime.ErrorEvent = ErrorEventImpl;
  runtime.PromiseRejectionEvent = PromiseRejectionEventImpl;
  adoptEventTarget(runtime);
  // The methods accept a missing receiver, so `addEventListener(...)` works
  // as a bare call in strict code, as it does on a browser's global scope.
  for (const [name, length] of [
    ["addEventListener", 2],
    ["removeEventListener", 2],
    ["dispatchEvent", 1],
  ] as const) {
    const method = EventTargetImpl.prototype[name] as Function;
    const global = function (this: unknown, ...args: unknown[]) {
      return method.apply(this === undefined || this === null ? runtime : this, args);
    };
    Object.defineProperty(global, "name", {
      value: name,
    });
    Object.defineProperty(global, "length", {
      value: length,
    });
    Object.defineProperty(runtime, name, {
      value: global,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  // `globalThis instanceof EventTarget`, where the engine lets the global
  // object's prototype change.
  if (Object.getPrototypeOf(runtime) === Object.prototype) {
    try {
      Object.setPrototypeOf(runtime, EventTargetImpl.prototype);
    } catch {
      // The methods above still make the global scope an event target.
    }
  }
  // OnErrorEventHandler receives the ErrorEvent's fields, and returning true
  // cancels the event.
  defineEventHandler(runtime, "error", (handler, target, event) => {
    if (event instanceof ErrorEventImpl) {
      const result = handler.call(
        target,
        event.message,
        event.filename,
        event.lineno,
        event.colno,
        event.error,
      );
      if (result === true) {
        event.preventDefault();
      }
    } else if (handler.call(target, event) === false) {
      event.preventDefault();
    }
  });
  defineEventHandler(runtime, "unhandledrejection");
  defineEventHandler(runtime, "rejectionhandled");
}

runtime.ErrorEvent ??= ErrorEventImpl;
runtime.PromiseRejectionEvent ??= PromiseRejectionEventImpl;

function describe(error: unknown): string {
  try {
    return `Uncaught ${String(error)}`;
  } catch {
    return "Uncaught exception";
  }
}

/** Set while an error event is dispatched, so errors in its listeners only log. */
let reporting = false;

/** HTML "report an exception": an error event, then the console unless canceled. */
export function reportException(error: unknown) {
  if (globalEvents && !reporting) {
    reporting = true;
    try {
      const event = new ErrorEventImpl("error", {
        message: describe(error),
        error,
        cancelable: true,
      });
      if (!dispatchTrusted(runtime, event)) {
        return;
      }
    } finally {
      reporting = false;
    }
  }
  runtime.console?.error?.("Uncaught", error);
}

runtime.reportError ??= function reportError(error: unknown) {
  if (arguments.length < 1) {
    throw new TypeError("reportError requires an argument");
  }
  reportException(error);
};

// A rejection's reason, and the context in which the promise was rejected.
// Both rejection events run in that context, as in Node, Deno and Workers.
interface Rejection {
  reason: unknown;
  snapshot: Snapshot;
}

// Rejected promises without a handler, in rejection order, until the next
// checkpoint notifies them.
const aboutToBeNotified = new Map<object, Rejection>();
// Notified promises that may still gain a handler.
const outstanding = new WeakMap<object, Rejection>();
// Notified promises that gained a handler, for rejectionhandled.
const handledLater: Array<[object, Rejection]> = [];

function hidden(name: string, value: Function) {
  Object.defineProperty(runtime, name, {
    value,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

hidden("__fetchletPromiseRejection", (promise: object, reason: unknown, handled: boolean) => {
  if (!handled) {
    aboutToBeNotified.set(promise, {
      reason,
      snapshot: new Snapshot(),
    });
  } else if (aboutToBeNotified.has(promise)) {
    aboutToBeNotified.delete(promise);
  } else if (outstanding.has(promise)) {
    handledLater.push([promise, outstanding.get(promise)!]);
    outstanding.delete(promise);
  }
});

function notifyUnhandled(promise: object, reason: unknown) {
  let notHandled = true;
  if (globalEvents) {
    try {
      notHandled = dispatchTrusted(
        runtime,
        new PromiseRejectionEventImpl("unhandledrejection", {
          promise,
          reason,
          cancelable: true,
        }),
      );
    } catch (error) {
      reportException(error);
    }
  }
  if (notHandled) {
    runtime.console?.error?.("Uncaught (in promise)", reason);
  }
}

hidden("__fetchletFlushRejections", () => {
  const rejected = [...aboutToBeNotified];
  aboutToBeNotified.clear();
  for (const [promise, rejection] of rejected) {
    rejection.snapshot.run(notifyUnhandled, promise, rejection.reason);
    outstanding.set(promise, rejection);
  }
  for (const [promise, { reason, snapshot }] of handledLater.splice(0)) {
    if (globalEvents) {
      snapshot.run(() =>
        dispatchTrusted(
          runtime,
          new PromiseRejectionEventImpl("rejectionhandled", {
            promise,
            reason,
          }),
        ),
      );
    }
  }
});

export { ErrorEventImpl, PromiseRejectionEventImpl };
