import { runtime } from "../runtime/runtime";
import { defineEventHandler, dispatchTrusted, EventTargetImpl } from "./events";

const internal = Symbol("fetchlet.abort");

function abortError() {
  return new runtime.DOMException("signal is aborted without reason", "AbortError");
}

// A host EventTarget, when present, stays the base so `instanceof` holds.
const Base: typeof EventTargetImpl = runtime.EventTarget;

function fireAbort(signal: AbortSignalImpl) {
  const event = new runtime.Event("abort");
  if (Base === EventTargetImpl) {
    dispatchTrusted(signal, event);
  } else {
    signal.dispatchEvent(event);
  }
}

class AbortSignalImpl extends Base {
  #aborted = false;
  #reason: any = undefined;
  // DOM "dependent signal" bookkeeping for AbortSignal.any().
  #dependent = false;
  #sources = new Set<AbortSignalImpl>();
  #dependents = new Set<AbortSignalImpl>();

  constructor(token?: symbol) {
    if (token !== internal) {
      throw new TypeError("Illegal constructor");
    }
    super();
  }

  get aborted() {
    return this.#aborted;
  }

  get reason() {
    return this.#reason;
  }

  throwIfAborted() {
    if (this.#aborted) {
      throw this.#reason;
    }
  }

  /** DOM "signal abort": mark this signal and its dependents, then fire events in order. */
  static [internal](signal: AbortSignalImpl, reason: any) {
    if (signal.#aborted) {
      return;
    }
    signal.#aborted = true;
    signal.#reason = reason === undefined ? abortError() : reason;
    const dependents: AbortSignalImpl[] = [];
    for (const dependent of signal.#dependents) {
      if (dependent.#aborted) {
        continue;
      }
      dependent.#aborted = true;
      dependent.#reason = signal.#reason;
      dependents.push(dependent);
    }
    fireAbort(signal);
    for (const dependent of dependents) {
      fireAbort(dependent);
    }
  }

  static abort(reason?: any) {
    const signal = new AbortSignalImpl(internal);
    signal.#aborted = true;
    signal.#reason = reason === undefined ? abortError() : reason;
    return signal;
  }

  static timeout(milliseconds: any) {
    const delay = +milliseconds;
    if (!Number.isFinite(delay) || delay < 0 || delay > Number.MAX_SAFE_INTEGER) {
      throw new TypeError("AbortSignal.timeout expects a non-negative safe integer");
    }
    const signal = new AbortSignalImpl(internal);
    // The timer belongs to the current invocation and is collected when it completes.
    runtime.setTimeout(() => {
      AbortSignalImpl[internal](
        signal,
        new runtime.DOMException("signal timed out", "TimeoutError"),
      );
    }, Math.trunc(delay));
    return signal;
  }

  static any(signals: any) {
    if (signals === null || typeof signals !== "object" || !(Symbol.iterator in signals)) {
      throw new TypeError("AbortSignal.any expects a sequence of signals");
    }
    const list = Array.from(signals as Iterable<any>);
    for (const signal of list) {
      if (!(signal instanceof AbortSignalImpl)) {
        throw new TypeError("Expected AbortSignal");
      }
    }
    const result = new AbortSignalImpl(internal);
    for (const signal of list) {
      if (signal.#aborted) {
        result.#aborted = true;
        result.#reason = signal.#reason;
        return result;
      }
    }
    result.#dependent = true;
    for (const signal of list) {
      const sources = signal.#dependent ? signal.#sources : [signal];
      for (const source of sources) {
        result.#sources.add(source);
        source.#dependents.add(result);
      }
    }
    return result;
  }

  get [Symbol.toStringTag]() {
    return "AbortSignal";
  }
}

defineEventHandler(AbortSignalImpl.prototype, "abort");

class AbortControllerImpl {
  #signal = new AbortSignalImpl(internal);

  get signal() {
    return this.#signal;
  }

  abort(reason?: any) {
    AbortSignalImpl[internal](this.#signal, reason);
  }

  get [Symbol.toStringTag]() {
    return "AbortController";
  }
}

Object.defineProperty(AbortSignalImpl, "name", {
  value: "AbortSignal",
});
Object.defineProperty(AbortControllerImpl, "name", {
  value: "AbortController",
});

runtime.AbortController ??= AbortControllerImpl;
runtime.AbortSignal ??= AbortSignalImpl;
