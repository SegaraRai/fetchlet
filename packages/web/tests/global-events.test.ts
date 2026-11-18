// Error reporting on the global scope: ErrorEvent from reportError and
// PromiseRejectionEvent from the engine's rejection tracker hooks.

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import "../src/internal/dom/events.ts";
import "../src/internal/html/global-events.ts";
import { runtime } from "../src/internal/runtime/runtime.ts";

vi.mock(import("../src/internal/runtime/runtime.ts"), async () =>
  (await import("./isolated-runtime.ts")).isolatedRuntime([
    "Event",
    "CustomEvent",
    "EventTarget",
    "ErrorEvent",
    "PromiseRejectionEvent",
    "reportError",
    "addEventListener",
    "removeEventListener",
    "dispatchEvent",
  ]),
);

const track = (promise: object, reason: unknown, handled: boolean) =>
  runtime.__fetchletPromiseRejection(promise, reason, handled);
const flush = () => runtime.__fetchletFlushRejections();

let consoleError: ReturnType<typeof vi.spyOn>;
const cleanups: Array<() => void> = [];

function listen(type: string, listener: (event: any) => void) {
  runtime.addEventListener(type, listener);
  cleanups.push(() => runtime.removeEventListener(type, listener));
}

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  runtime.onerror = null;
  runtime.onunhandledrejection = null;
  consoleError.mockRestore();
});

describe("the event constructors", () => {
  test("ErrorEvent converts its init dictionary", () => {
    const error = new Error("boom");
    const event = new runtime.ErrorEvent("error", {
      message: "boom",
      filename: "app.js",
      lineno: 2 ** 32 + 3,
      colno: -1,
      error,
    });
    expect([event.message, event.filename, event.lineno, event.colno, event.error]).toStrictEqual([
      "boom",
      "app.js",
      3,
      2 ** 32 - 1,
      error,
    ]);
    const empty = new runtime.ErrorEvent("error");
    expect([empty.message, empty.filename, empty.lineno, empty.colno, empty.error]).toStrictEqual([
      "",
      "",
      0,
      0,
      undefined,
    ]);
    expect(empty).toBeInstanceOf(runtime.Event);
    expect(Object.prototype.toString.call(empty)).toBe("[object ErrorEvent]");
  });

  test("PromiseRejectionEvent requires a promise object", () => {
    const promise = Promise.resolve();
    const event = new runtime.PromiseRejectionEvent("unhandledrejection", {
      promise,
      reason: "why",
      cancelable: true,
    });
    expect([event.promise, event.reason, event.cancelable]).toStrictEqual([promise, "why", true]);
    expect(() => new runtime.PromiseRejectionEvent("unhandledrejection")).toThrow(TypeError);
    expect(() => new runtime.PromiseRejectionEvent("unhandledrejection", {})).toThrow(TypeError);
    expect(() => new runtime.PromiseRejectionEvent("unhandledrejection", { promise: 1 })).toThrow(
      TypeError,
    );
  });
});

describe("the global scope", () => {
  test("has the EventTarget methods, also as bare calls", () => {
    const { addEventListener, dispatchEvent, removeEventListener } = runtime;
    const seen: unknown[] = [];
    const listener = function (this: unknown, event: Event) {
      seen.push([this, event.type, event.target]);
    };
    addEventListener("ping", listener);
    expect(dispatchEvent(new runtime.Event("ping"))).toBe(true);
    removeEventListener("ping", listener);
    dispatchEvent(new runtime.Event("ping"));
    expect(seen).toStrictEqual([[runtime, "ping", runtime]]);
    expect(addEventListener.name).toBe("addEventListener");
    expect(addEventListener.length).toBe(2);
  });

  test("reportError dispatches a cancelable ErrorEvent, then logs unless canceled", () => {
    const error = new TypeError("bad");
    const events: any[] = [];
    listen("error", (event) => events.push(event));
    runtime.reportError(error);
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(runtime.ErrorEvent);
    expect([events[0].isTrusted, events[0].cancelable, events[0].error]).toStrictEqual([
      true,
      true,
      error,
    ]);
    expect(events[0].message).toBe("Uncaught TypeError: bad");
    expect(consoleError).toHaveBeenCalledWith("Uncaught", error);

    consoleError.mockClear();
    listen("error", (event) => event.preventDefault());
    runtime.reportError(error);
    expect(consoleError).not.toHaveBeenCalled();
    expect(() => runtime.reportError()).toThrow(TypeError);
  });

  test("onerror receives the error fields and cancels by returning true", () => {
    const calls: unknown[] = [];
    runtime.onerror = (...args: unknown[]) => {
      calls.push(args);
      return true;
    };
    const error = new Error("x");
    runtime.reportError(error);
    expect(calls).toStrictEqual([["Uncaught Error: x", "", 0, 0, error]]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("an error thrown by an error listener is logged, not reported again", () => {
    const thrown = new Error("from the listener");
    let calls = 0;
    listen("error", () => {
      calls += 1;
      throw thrown;
    });
    runtime.reportError(new Error("first"));
    expect(calls).toBe(1);
    expect(consoleError.mock.calls.map((call: unknown[]) => call[1])).toContain(thrown);
  });
});

describe("rejection tracking", () => {
  test("notifies rejections still unhandled at the flush", () => {
    const promise = {};
    const events: any[] = [];
    listen("unhandledrejection", (event) => events.push(event));
    track(promise, "reason", false);
    expect(events).toHaveLength(0);
    flush();
    expect(events).toHaveLength(1);
    expect([events[0].promise, events[0].reason, events[0].cancelable]).toStrictEqual([
      promise,
      "reason",
      true,
    ]);
    expect(consoleError).toHaveBeenCalledWith("Uncaught (in promise)", "reason");
    flush();
    expect(events).toHaveLength(1);
  });

  test("a handler added before the flush cancels the notification", () => {
    const events: unknown[] = [];
    listen("unhandledrejection", (event) => events.push(event));
    const promise = {};
    track(promise, "reason", false);
    track(promise, "reason", true);
    flush();
    expect(events).toStrictEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("a canceled unhandledrejection is not logged", () => {
    runtime.onunhandledrejection = (event: Event) => event.preventDefault();
    track({}, "quiet", false);
    flush();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("a handler added after the notification dispatches rejectionhandled", () => {
    const promise = {};
    const handled: any[] = [];
    listen("rejectionhandled", (event) => handled.push(event));
    track(promise, "late", false);
    flush();
    track(promise, "late", true);
    expect(handled).toHaveLength(0);
    flush();
    expect(handled).toHaveLength(1);
    expect([handled[0].promise, handled[0].reason, handled[0].cancelable]).toStrictEqual([
      promise,
      "late",
      false,
    ]);
  });

  test("notifies in rejection order", () => {
    const reasons: unknown[] = [];
    listen("unhandledrejection", (event) => reasons.push(event.reason));
    track({}, 1, false);
    track({}, 2, false);
    flush();
    expect(reasons).toStrictEqual([1, 2]);
  });
});
