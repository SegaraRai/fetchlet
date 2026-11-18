// Async context over an engine slot: Variable and Snapshot, and the host
// task sources that run callbacks in the context that scheduled them. The
// slot is Node's AsyncLocalStorage, which propagates through promise
// reactions as an engine slot does.

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import "../src/abort.ts";
import { Snapshot, Variable, enter, leave, propagates } from "../src/async-context.ts";
import "../src/events.ts";
import "../src/global-events.ts";
import "../src/message-channel.ts";
import { runtime } from "../src/runtime.ts";
import "../src/timers.ts";

vi.mock(import("../src/runtime.ts"), async () => {
  const { isolatedRuntime, nodeAsyncContextSlot } = await import("./isolated-runtime.ts");
  const isolated = isolatedRuntime([
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "AbortController",
    "AbortSignal",
    "Event",
    "CustomEvent",
    "EventTarget",
    "ErrorEvent",
    "PromiseRejectionEvent",
    "reportError",
    "addEventListener",
    "removeEventListener",
    "dispatchEvent",
    "MessageChannel",
    "MessagePort",
    "MessageEvent",
  ]);
  isolated.runtime.__fetchletAsyncContext = await nodeAsyncContextSlot();
  return isolated;
});

/** Runs the profile's due timers, as the host's event loop does. */
function runTimers() {
  for (let turn = 0; turn < 100 && runtime.__fetchletRunNextTimer(); turn += 1) {
    // Each call runs one timer.
  }
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  runtime.__fetchletClearTimers();
});

describe("Variable", () => {
  test("has its value inside run only, and its default outside", () => {
    const variable = new Variable<string>({ name: "request", defaultValue: "none" });
    expect(propagates).toBe(true);
    expect(variable.name).toBe("request");
    expect(variable.get()).toBe("none");
    const inner = variable.run("a", (suffix: string) => variable.get() + suffix, "!");
    expect(inner).toBe("a!");
    expect(variable.get()).toBe("none");
  });

  test("restores the outer value after nested runs and exceptions", () => {
    const variable = new Variable<number>();
    variable.run(1, () => {
      expect(() =>
        variable.run(2, () => {
          expect(variable.get()).toBe(2);
          throw new Error("inner");
        }),
      ).toThrow("inner");
      expect(variable.get()).toBe(1);
    });
    expect(variable.get()).toBeUndefined();
  });

  test("keeps concurrent runs apart across awaits", async () => {
    const variable = new Variable<string>();
    const reader = async (value: string) =>
      variable.run(value, async () => {
        const seen: unknown[] = [];
        for (let turn = 0; turn < 3; turn += 1) {
          await tick();
          seen.push(variable.get());
        }
        return seen;
      });
    expect(await Promise.all([reader("a"), reader("b")])).toStrictEqual([
      ["a", "a", "a"],
      ["b", "b", "b"],
    ]);
    expect(variable.get()).toBeUndefined();
  });

  test("leaves other variables' values in place", () => {
    const first = new Variable<string>();
    const second = new Variable<string>();
    first.run("one", () =>
      second.run("two", () => {
        expect([first.get(), second.get()]).toStrictEqual(["one", "two"]);
      }),
    );
    expect(first.get()).toBeUndefined();
  });
});

describe("Snapshot", () => {
  test("runs a callback in the mapping current at its creation", () => {
    const variable = new Variable<string>();
    const snapshot = variable.run("captured", () => new Snapshot());
    expect(snapshot.run(() => variable.get())).toBe("captured");
    variable.run("other", () => {
      expect(snapshot.run(() => variable.get())).toBe("captured");
      expect(variable.get()).toBe("other");
    });
  });

  test("wraps a function with its this value and arguments", () => {
    const variable = new Variable<string>();
    const wrapped = variable.run("bound", () =>
      Snapshot.wrap(function (this: { prefix: string }, suffix: string) {
        return this.prefix + variable.get() + suffix;
      }),
    );
    expect(wrapped.call({ prefix: "<" }, ">")).toBe("<bound>");
  });
});

describe("enter and leave", () => {
  test("last until the enclosing run returns, across awaits inside it", async () => {
    const variable = new Variable<string>();
    const seen = await variable.run("outer", async () => {
      enter(variable, "entered");
      await tick();
      const afterAwait = variable.get();
      leave(variable);
      return [afterAwait, variable.get()];
    });
    expect(seen).toStrictEqual(["entered", undefined]);
    expect(variable.get()).toBeUndefined();
  });
});

describe("host task sources", () => {
  test("timers run in the context of the call that scheduled them", () => {
    const variable = new Variable<string>();
    const seen: unknown[] = [];
    variable.run("timeout", () => runtime.setTimeout(() => seen.push(variable.get()), 0));
    let count = 0;
    const id = variable.run("interval", () =>
      runtime.setInterval(() => {
        seen.push(variable.get());
        count += 1;
        if (count === 2) {
          runtime.clearInterval(id);
        }
      }, 0),
    );
    runTimers();
    expect(seen).toStrictEqual(["timeout", "interval", "interval"]);
    expect(variable.get()).toBeUndefined();
  });

  test("AbortSignal.timeout fires in the context of its call", () => {
    const variable = new Variable<string>();
    const seen: unknown[] = [];
    const signal = variable.run("timeout call", () => runtime.AbortSignal.timeout(0));
    signal.addEventListener("abort", () => seen.push(variable.get()));
    runTimers();
    expect(signal.aborted).toBe(true);
    expect(seen).toStrictEqual(["timeout call"]);
  });

  test("message listeners run in the context of the channel's creation", () => {
    const variable = new Variable<string>();
    const channel = variable.run("created", () => new runtime.MessageChannel());
    const seen: unknown[] = [];
    channel.port2.onmessage = () => seen.push(variable.get());
    variable.run("posted", () => channel.port1.postMessage(null));
    runTimers();
    expect(seen).toStrictEqual(["created"]);
    channel.port1.close();
  });

  test("rejection events run in the context of the rejection", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const variable = new Variable<string>();
    const seen: unknown[] = [];
    const listener = (event: any) => {
      seen.push([event.type, variable.get()]);
      event.preventDefault();
    };
    runtime.addEventListener("unhandledrejection", listener);
    runtime.addEventListener("rejectionhandled", listener);
    const promise = {};
    variable.run("rejected", () => runtime.__fetchletPromiseRejection(promise, "reason", false));
    runtime.__fetchletFlushRejections();
    variable.run("handled", () => runtime.__fetchletPromiseRejection(promise, undefined, true));
    runtime.__fetchletFlushRejections();
    runtime.removeEventListener("unhandledrejection", listener);
    runtime.removeEventListener("rejectionhandled", listener);
    consoleError.mockRestore();
    expect(seen).toStrictEqual([
      ["unhandledrejection", "rejected"],
      ["rejectionhandled", "rejected"],
    ]);
  });
});
