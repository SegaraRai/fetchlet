// node:events: each scenario runs with fetchlet's module and with Node's and
// must give the same result.

import * as nodeEvents from "node:events";

import * as fetchletEvents from "@fetchlet/node/events";
import { describe, expect, test } from "vite-plus/test";

type Events = typeof nodeEvents;

async function compare(scenario: (events: Events) => unknown): Promise<unknown> {
  const ours = await scenario(fetchletEvents as unknown as Events);
  const theirs = await scenario(nodeEvents);
  expect(ours).toStrictEqual(theirs);
  return ours;
}

function codeOf(run: () => void): unknown {
  try {
    run();
    return "no error";
  } catch (error) {
    return [(error as Error).name, (error as { code?: string }).code, (error as Error).message];
  }
}

describe("EventEmitter", () => {
  test("orders listeners, prepends and once wrappers", () =>
    compare(({ EventEmitter }) => {
      const emitter = new EventEmitter();
      const log: string[] = [];
      emitter.on("newListener", (name) => log.push(`new:${String(name)}`));
      emitter.on("event", (value) => log.push(`a:${value}`));
      emitter.prependListener("event", (value) => log.push(`first:${value}`));
      emitter.once("event", (value) => log.push(`once:${value}`));
      emitter.prependOnceListener("event", (value) => log.push(`prepended-once:${value}`));
      const results = [emitter.emit("event", 1), emitter.emit("event", 2), emitter.emit("missing")];
      return {
        log,
        results,
        count: emitter.listenerCount("event"),
        names: emitter.eventNames(),
      };
    }));

  test("rawListeners keep once wrappers with their listener", () =>
    compare(({ EventEmitter }) => {
      const emitter = new EventEmitter();
      const listener = () => {};
      emitter.once("x", listener);
      const [raw] = emitter.rawListeners("x") as Array<{ listener?: unknown }>;
      return [raw !== listener, raw.listener === listener, emitter.listeners("x")[0] === listener];
    }));

  test("removeListener removes the latest matching registration", () =>
    compare(({ EventEmitter }) => {
      const emitter = new EventEmitter();
      const log: string[] = [];
      const listener = () => log.push("listener");
      emitter.on("removeListener", (name) => log.push(`removed:${String(name)}`));
      emitter.on("x", listener);
      emitter.once("x", listener);
      emitter.off("x", listener);
      emitter.emit("x");
      emitter.removeAllListeners("x");
      emitter.emit("x");
      return { log, count: emitter.listenerCount("x") };
    }));

  test("removing during emit does not affect the current emit", () =>
    compare(({ EventEmitter }) => {
      const emitter = new EventEmitter();
      const log: string[] = [];
      const second = () => log.push("second");
      emitter.on("x", () => {
        log.push("first");
        emitter.off("x", second);
      });
      emitter.on("x", second);
      emitter.emit("x");
      emitter.emit("x");
      return log;
    }));

  test("error events throw without a listener", () =>
    compare(({ EventEmitter, errorMonitor }) => {
      const emitter = new EventEmitter();
      const seen: string[] = [];
      emitter.on(errorMonitor, (error: Error) => seen.push(`monitor:${error.message}`));
      const thrown = codeOf(() => emitter.emit("error", new Error("boom")));
      const unhandled = codeOf(() => emitter.emit("error", "text"));
      emitter.on("error", (error: Error) => seen.push(`handled:${error.message}`));
      emitter.emit("error", new Error("caught"));
      return { thrown, unhandled: (unhandled as unknown[]).slice(0, 2), seen };
    }));

  test("max listeners", () =>
    compare(({ EventEmitter }) => {
      const emitter = new EventEmitter();
      const before = emitter.getMaxListeners();
      emitter.setMaxListeners(1);
      return [before, emitter.getMaxListeners(), EventEmitter.defaultMaxListeners];
    }));

  test("subclasses and listener this", () =>
    compare(({ EventEmitter }) => {
      class Custom extends EventEmitter {}
      const emitter = new Custom();
      let self: unknown;
      emitter.on("x", function (this: unknown) {
        self = this;
      });
      emitter.emit("x");
      return [self === emitter, emitter instanceof EventEmitter];
    }));

  test("validates listeners like Node", () =>
    compare(({ EventEmitter }) => codeOf(() => new EventEmitter().on("x", "nope" as never))));
});

test("EventEmitter initializes function-style subclasses, as older libraries define them", () => {
  const { EventEmitter } = fetchletEvents;
  function Legacy(this: InstanceType<typeof EventEmitter>) {
    EventEmitter.call(this);
  }
  Object.setPrototypeOf(Legacy.prototype, EventEmitter.prototype);
  const emitter = new (Legacy as unknown as new () => InstanceType<typeof EventEmitter>)();
  const received: unknown[] = [];
  emitter.on("event", (value) => received.push(value));
  emitter.emit("event", 1);
  expect(received).toStrictEqual([1]);
  expect(emitter).toBeInstanceOf(EventEmitter);
  expect(new EventEmitter().constructor).toBe(EventEmitter);
  expect(EventEmitter.EventEmitter).toBe(EventEmitter);
  expect(typeof EventEmitter.once).toBe("function");
});

describe("module functions", () => {
  test("once resolves with the arguments and rejects on error", () =>
    compare(async ({ EventEmitter, once }) => {
      const emitter = new EventEmitter();
      const resolved = once(emitter, "ready");
      emitter.emit("ready", 1, 2);
      const failed = once(emitter, "ready");
      emitter.emit("error", new Error("bad"));
      return [
        await resolved,
        await failed.catch((error: Error) => error.message),
        emitter.listenerCount("error"),
      ];
    }));

  test("once works on EventTarget and honors signals", () =>
    compare(async ({ once }) => {
      const target = new EventTarget();
      const waiting = once(target, "ping");
      target.dispatchEvent(new Event("ping"));
      const [event] = (await waiting) as Event[];
      const controller = new AbortController();
      const aborted = once(target, "never", { signal: controller.signal });
      controller.abort();
      const error = await aborted.catch((reason: { name: string; code: string }) => [
        reason.name,
        reason.code,
      ]);
      return [event.type, error];
    }));

  test("on iterates events until aborted", () =>
    compare(async ({ EventEmitter, on }) => {
      const emitter = new EventEmitter();
      const controller = new AbortController();
      const values: unknown[] = [];
      queueMicrotask(() => {
        emitter.emit("data", "a");
        emitter.emit("data", "b");
        queueMicrotask(() => controller.abort());
      });
      try {
        for await (const [value] of on(emitter, "data", { signal: controller.signal })) {
          values.push(value);
        }
      } catch (error) {
        values.push((error as { name: string }).name);
      }
      return [values, emitter.listenerCount("data")];
    }));

  test("getEventListeners and listenerCount", () =>
    compare(({ EventEmitter, getEventListeners, listenerCount }) => {
      const emitter = new EventEmitter();
      const listener = () => {};
      emitter.on("x", listener);
      return [getEventListeners(emitter, "x").length, listenerCount(emitter, "x")];
    }));

  test("the default export is the class with its statics", () =>
    compare((events) => {
      const EventEmitter = (events as unknown as { default: Events["EventEmitter"] }).default;
      return [
        EventEmitter === events.EventEmitter,
        typeof EventEmitter.once,
        typeof EventEmitter.on,
        EventEmitter.EventEmitter === EventEmitter,
        typeof EventEmitter.errorMonitor,
      ];
    }));
});
