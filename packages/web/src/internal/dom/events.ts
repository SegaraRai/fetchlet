// DOM Event, CustomEvent and EventTarget for targets without a tree: every
// dispatch reaches only its target (https://dom.spec.whatwg.org/#events).
// Engines that already provide them keep their own.

import { runtime } from "../runtime/runtime";

const NONE = 0;
const AT_TARGET = 2;

interface EventState {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
  target: EventTargetImpl | null;
  currentTarget: EventTargetImpl | null;
  phase: number;
  canceled: boolean;
  stopPropagation: boolean;
  stopImmediate: boolean;
  inPassiveListener: boolean;
  dispatching: boolean;
  initialized: boolean;
  trusted: boolean;
  timeStamp: number;
}

const events = new WeakMap<object, EventState>();

function state(event: unknown): EventState {
  const found = events.get(event as object);
  if (!found) {
    throw new TypeError("Illegal invocation");
  }
  return found;
}

function now(): number {
  return runtime.performance?.now?.() ?? Date.now();
}

const isTrusted = Object.defineProperty(
  function (this: unknown): boolean {
    return state(this).trusted;
  },
  "name",
  { value: "get isTrusted" },
);

class EventImpl {
  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;

  constructor(
    type: string,
    init?: {
      bubbles?: boolean;
      cancelable?: boolean;
      composed?: boolean;
    },
  ) {
    if (arguments.length < 1) {
      throw new TypeError("Event requires a type");
    }
    if (init !== undefined && init !== null && typeof init !== "object") {
      throw new TypeError("Event init must be an object");
    }
    events.set(this, {
      type: String(type),
      bubbles: !!init?.bubbles,
      cancelable: !!init?.cancelable,
      composed: !!init?.composed,
      target: null,
      currentTarget: null,
      phase: NONE,
      canceled: false,
      stopPropagation: false,
      stopImmediate: false,
      inPassiveListener: false,
      dispatching: false,
      initialized: true,
      trusted: false,
      timeStamp: now(),
    });
    // `isTrusted` is [LegacyUnforgeable]: an own accessor of every event,
    // sharing one getter.
    Object.defineProperty(this, "isTrusted", {
      get: isTrusted,
      enumerable: true,
      configurable: false,
    });
  }

  declare readonly isTrusted: boolean;

  get type() {
    return state(this).type;
  }

  get target() {
    return state(this).target;
  }

  get srcElement() {
    return state(this).target;
  }

  get currentTarget() {
    return state(this).currentTarget;
  }

  get eventPhase() {
    return state(this).phase;
  }

  get bubbles() {
    return state(this).bubbles;
  }

  get cancelable() {
    return state(this).cancelable;
  }

  get composed() {
    return state(this).composed;
  }

  get defaultPrevented() {
    return state(this).canceled;
  }

  get timeStamp() {
    return state(this).timeStamp;
  }

  get returnValue() {
    return !state(this).canceled;
  }

  set returnValue(value: boolean) {
    if (!value) {
      this.preventDefault();
    }
  }

  get cancelBubble() {
    return state(this).stopPropagation;
  }

  set cancelBubble(value: boolean) {
    if (value) {
      state(this).stopPropagation = true;
    }
  }

  composedPath(): EventTargetImpl[] {
    const { currentTarget } = state(this);
    return currentTarget ? [currentTarget] : [];
  }

  preventDefault() {
    const event = state(this);
    if (event.cancelable && !event.inPassiveListener) {
      event.canceled = true;
    }
  }

  stopPropagation() {
    state(this).stopPropagation = true;
  }

  stopImmediatePropagation() {
    const event = state(this);
    event.stopPropagation = true;
    event.stopImmediate = true;
  }

  initEvent(type: string, bubbles = false, cancelable = false) {
    const event = state(this);
    if (event.dispatching) {
      return;
    }
    Object.assign(event, {
      type: String(type),
      bubbles: !!bubbles,
      cancelable: !!cancelable,
      initialized: true,
      stopPropagation: false,
      stopImmediate: false,
      canceled: false,
      target: null,
    });
  }

  get [Symbol.toStringTag]() {
    return "Event";
  }
}

class CustomEventImpl extends EventImpl {
  #detail: unknown;

  constructor(
    type: string,
    init?: {
      bubbles?: boolean;
      cancelable?: boolean;
      composed?: boolean;
      detail?: unknown;
    },
  ) {
    if (arguments.length < 1) {
      throw new TypeError("CustomEvent requires a type");
    }
    super(type, init);
    this.#detail = init?.detail ?? null;
  }

  get detail() {
    return this.#detail;
  }

  initCustomEvent(type: string, bubbles = false, cancelable = false, detail: unknown = null) {
    if (state(this).dispatching) {
      return;
    }
    this.initEvent(type, bubbles, cancelable);
    this.#detail = detail;
  }

  get [Symbol.toStringTag]() {
    return "CustomEvent";
  }
}

interface Listener {
  type: string;
  callback: any;
  capture: boolean;
  once: boolean;
  passive: boolean;
  removed: boolean;
}

/** DOM "flatten": removeEventListener reads only `capture`. */
function flatten(options: unknown): boolean {
  if (typeof options === "boolean") {
    return options;
  }
  if (options === null || typeof options !== "object") {
    return false;
  }
  return !!(options as { capture?: unknown }).capture;
}

/**
 * DOM "flatten more", reading the AddEventListenerOptions members in WebIDL
 * dictionary order: capture, then once, passive and signal.
 */
function flattenMore(options: unknown) {
  const capture = flatten(options);
  if (options === null || typeof options !== "object") {
    return { capture, once: false, passive: false, signal: undefined };
  }
  const value = options as { once?: unknown; passive?: unknown; signal?: any };
  const once = !!value.once;
  const passive = !!value.passive;
  const signal = value.signal;
  if (signal !== undefined && (signal === null || typeof signal.aborted !== "boolean")) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return { capture, once, passive, signal };
}

const listeners = new WeakMap<object, Listener[]>();

function listenersOf(target: unknown): Listener[] {
  const found = listeners.get(target as object);
  if (!found) {
    throw new TypeError("Illegal invocation");
  }
  return found;
}

function remove(list: Listener[], listener: Listener) {
  listener.removed = true;
  const index = list.indexOf(listener);
  if (index >= 0) {
    list.splice(index, 1);
  }
}

/** Reports an exception thrown by a listener without interrupting the dispatch. */
function report(error: unknown) {
  if (typeof runtime.reportError === "function") {
    runtime.reportError(error);
  } else {
    runtime.console?.error?.(error);
  }
}

class EventTargetImpl {
  constructor() {
    listeners.set(this, []);
  }

  addEventListener(type: string, callback: any, options?: unknown) {
    if (arguments.length < 2) {
      throw new TypeError("addEventListener requires two arguments");
    }
    const list = listenersOf(this);
    const name = String(type);
    // Options are converted, and a bad signal rejected, even for a null callback.
    const { capture, once, passive, signal } = flattenMore(options);
    if (callback === null || callback === undefined || signal?.aborted) {
      return;
    }
    if (
      list.some(
        (entry) => entry.type === name && entry.callback === callback && entry.capture === capture,
      )
    ) {
      return;
    }
    list.push({
      type: name,
      callback,
      capture,
      once,
      passive,
      removed: false,
    });
    signal?.addEventListener("abort", () => {
      this.removeEventListener(name, callback, { capture });
    });
  }

  removeEventListener(type: string, callback: any, options?: unknown) {
    if (arguments.length < 2) {
      throw new TypeError("removeEventListener requires two arguments");
    }
    const list = listenersOf(this);
    const name = String(type);
    const capture = flatten(options);
    const found = list.find(
      (entry) => entry.type === name && entry.callback === callback && entry.capture === capture,
    );
    if (found) {
      remove(list, found);
    }
  }

  dispatchEvent(event: EventImpl): boolean {
    if (arguments.length < 1) {
      throw new TypeError("dispatchEvent requires an event");
    }
    const current = state(event);
    if (current.dispatching || !current.initialized) {
      throw new runtime.DOMException("The event is already being dispatched", "InvalidStateError");
    }
    current.trusted = false;
    return dispatch(this, event);
  }

  get [Symbol.toStringTag]() {
    return "EventTarget";
  }
}

function dispatch(target: EventTargetImpl, event: EventImpl): boolean {
  const current = state(event);
  const list = listenersOf(target);
  current.dispatching = true;
  current.target = target;
  current.currentTarget = target;
  current.phase = AT_TARGET;
  try {
    if (!current.stopPropagation) {
      for (const listener of list.slice()) {
        if (current.stopImmediate) {
          break;
        }
        if (listener.removed || listener.type !== current.type) {
          continue;
        }
        if (listener.once) {
          remove(list, listener);
        }
        current.inPassiveListener = listener.passive;
        try {
          if (typeof listener.callback === "function") {
            listener.callback.call(target, event);
          } else if (typeof listener.callback?.handleEvent === "function") {
            listener.callback.handleEvent(event);
          }
        } catch (error) {
          report(error);
        } finally {
          current.inPassiveListener = false;
        }
      }
    }
  } finally {
    current.dispatching = false;
    current.phase = NONE;
    current.currentTarget = null;
    current.stopPropagation = false;
    current.stopImmediate = false;
  }
  return !current.canceled;
}

/**
 * Gives an object that is not an EventTarget instance its own listener list,
 * so the EventTarget methods accept it as their receiver. The global scope
 * uses it.
 */
export function adoptEventTarget(target: object) {
  if (!listeners.has(target)) {
    listeners.set(target, []);
  }
}

/** Dispatches an event the platform creates, which reports `isTrusted`. */
export function dispatchTrusted(target: EventTargetImpl, event: EventImpl): boolean {
  state(event).trusted = true;
  return dispatch(target, event);
}

/**
 * Defines an event handler attribute such as `onabort`. Like the DOM's, the
 * handler runs at the position where it was first set among the listeners.
 */
export function defineEventHandler(
  prototype: object,
  type: string,
  invoke: (handler: Function, target: object, event: EventImpl) => void = invokeHandler,
) {
  const handlers = new WeakMap<
    object,
    {
      value: any;
      listener: (event: EventImpl) => void;
    }
  >();
  Object.defineProperty(prototype, `on${type}`, {
    configurable: true,
    enumerable: true,
    get(this: EventTargetImpl) {
      return handlers.get(this)?.value ?? null;
    },
    set(this: EventTargetImpl, value: unknown) {
      const callback =
        typeof value === "function" || (value && typeof value === "object") ? value : null;
      const existing = handlers.get(this);
      if (callback === null) {
        if (existing) {
          this.removeEventListener(type, existing.listener);
          handlers.delete(this);
        }
        return;
      }
      if (existing) {
        existing.value = callback;
        return;
      }
      const entry = {
        value: callback,
        listener: (event: EventImpl) => {
          const handler = handlers.get(this)?.value;
          if (typeof handler === "function") {
            invoke(handler, this, event);
          }
        },
      };
      handlers.set(this, entry);
      this.addEventListener(type, entry.listener);
    },
  });
}

/** A handler that returns false cancels the event. */
function invokeHandler(handler: Function, target: object, event: EventImpl) {
  if (handler.call(target, event) === false) {
    event.preventDefault();
  }
}

for (const [constructor, name] of [
  [EventImpl, "Event"],
  [CustomEventImpl, "CustomEvent"],
  [EventTargetImpl, "EventTarget"],
] as const) {
  Object.defineProperty(constructor, "name", {
    value: name,
  });
}
for (const [name, value] of Object.entries({
  NONE: 0,
  CAPTURING_PHASE: 1,
  AT_TARGET: 2,
  BUBBLING_PHASE: 3,
})) {
  Object.defineProperty(EventImpl.prototype, name, {
    value,
    enumerable: true,
  });
}

runtime.Event ??= EventImpl;
runtime.CustomEvent ??= CustomEventImpl;
runtime.EventTarget ??= EventTargetImpl;

export { CustomEventImpl, EventImpl, EventTargetImpl };
