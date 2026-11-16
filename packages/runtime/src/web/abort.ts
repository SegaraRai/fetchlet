import { runtime } from "./runtime";

const internal = Symbol("fetchlet.abort");

type Listener = {
  callback: any;
  capture: boolean;
  once: boolean;
  removed: boolean;
  handler?: true;
};

function flattenOptions(options: any) {
  if (typeof options === "boolean") return { capture: options, once: false, signal: undefined };
  if (options === null || typeof options !== "object") {
    return { capture: false, once: false, signal: undefined };
  }
  return { capture: !!options.capture, once: !!options.once, signal: options.signal };
}

function abortError() {
  return new runtime.DOMException("signal is aborted without reason", "AbortError");
}

/** Minimal event object for the abort event when the host provides no Event constructor. */
function abortEvent(target: object) {
  if (typeof runtime.Event === "function") return new runtime.Event("abort");
  return {
    type: "abort",
    target,
    currentTarget: target,
    srcElement: target,
    eventPhase: 2,
    bubbles: false,
    cancelable: false,
    composed: false,
    defaultPrevented: false,
    isTrusted: true,
    timeStamp: runtime.performance?.now?.() ?? 0,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
    composedPath: () => [target],
  };
}

class AbortSignalImpl {
  #aborted = false;
  #reason: any = undefined;
  #listeners: Listener[] = [];
  #handler: any = null;
  // DOM "dependent signal" bookkeeping for AbortSignal.any().
  #dependent = false;
  #sources = new Set<AbortSignalImpl>();
  #dependents = new Set<AbortSignalImpl>();

  constructor(token?: symbol) {
    if (token !== internal) throw new TypeError("Illegal constructor");
  }

  get aborted() {
    return this.#aborted;
  }

  get reason() {
    return this.#reason;
  }

  get onabort() {
    return this.#handler;
  }

  set onabort(value: any) {
    const callback =
      typeof value === "function" || (value && typeof value === "object") ? value : null;
    if (callback !== null && this.#handler === null) {
      // An event handler occupies the listener position where it was first set.
      this.#listeners.push({
        callback: null,
        capture: false,
        once: false,
        removed: false,
        handler: true,
      });
    }
    if (callback === null) {
      const slot = this.#listeners.find((listener) => listener.handler);
      if (slot) {
        slot.removed = true;
        this.#listeners = this.#listeners.filter((listener) => listener !== slot);
      }
    }
    this.#handler = callback;
  }

  addEventListener(type: any, callback: any, options?: any) {
    if (arguments.length < 2) throw new TypeError("addEventListener requires two arguments");
    const { capture, once, signal } = flattenOptions(options);
    if (String(type) !== "abort" || callback === null || callback === undefined) return;
    if (signal?.aborted) return;
    const exists = this.#listeners.some(
      (listener) =>
        !listener.handler && listener.callback === callback && listener.capture === capture,
    );
    if (exists) return;
    const listener: Listener = { callback, capture, once, removed: false };
    this.#listeners.push(listener);
    signal?.addEventListener?.("abort", () => this.removeEventListener(type, callback, options));
  }

  removeEventListener(type: any, callback: any, options?: any) {
    if (arguments.length < 2) throw new TypeError("removeEventListener requires two arguments");
    const { capture } = flattenOptions(options);
    if (String(type) !== "abort") return;
    const index = this.#listeners.findIndex(
      (listener) =>
        !listener.handler && listener.callback === callback && listener.capture === capture,
    );
    if (index >= 0) {
      this.#listeners[index].removed = true;
      this.#listeners.splice(index, 1);
    }
  }

  dispatchEvent(event: any) {
    if (event?.type === "abort") this.#fire(event);
    return true;
  }

  throwIfAborted() {
    if (this.#aborted) throw this.#reason;
  }

  #fire(event: any) {
    for (const listener of this.#listeners.slice()) {
      if (listener.removed) continue;
      if (listener.once) this.removeEventListener("abort", listener.callback, listener);
      const callback = listener.handler ? this.#handler : listener.callback;
      try {
        if (typeof callback === "function") callback.call(this, event);
        else if (typeof callback?.handleEvent === "function") callback.handleEvent(event);
      } catch (error) {
        // Listener exceptions are reported, not propagated to the aborting caller.
        reportError(error);
      }
    }
  }

  /** DOM "signal abort": mark this signal and its dependents, then fire events in order. */
  static [internal](signal: AbortSignalImpl, reason: any) {
    if (signal.#aborted) return;
    signal.#aborted = true;
    signal.#reason = reason === undefined ? abortError() : reason;
    const dependents: AbortSignalImpl[] = [];
    for (const dependent of signal.#dependents) {
      if (dependent.#aborted) continue;
      dependent.#aborted = true;
      dependent.#reason = signal.#reason;
      dependents.push(dependent);
    }
    signal.#fire(abortEvent(signal));
    for (const dependent of dependents) dependent.#fire(abortEvent(dependent));
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
      if (!(signal instanceof AbortSignalImpl)) throw new TypeError("Expected AbortSignal");
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

function reportError(error: unknown) {
  if (typeof runtime.reportError === "function") runtime.reportError(error);
  else runtime.console?.error?.(error);
}

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

Object.defineProperty(AbortSignalImpl, "name", { value: "AbortSignal" });
Object.defineProperty(AbortControllerImpl, "name", { value: "AbortController" });

runtime.AbortController ??= AbortControllerImpl;
runtime.AbortSignal ??= AbortSignalImpl;
