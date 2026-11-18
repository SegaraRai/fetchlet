// The Performance interface with User Timing marks and measures over a fake
// host clock.

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import "../src/internal/dom/events.ts";
import "../src/internal/performance/performance.ts";
import { runtime } from "../src/internal/runtime/runtime.ts";

const clock = vi.hoisted(() => ({ now: 0 }));

vi.mock(import("../src/internal/runtime/runtime.ts"), async () =>
  (await import("./isolated-runtime.ts")).isolatedRuntime(
    [
      "Event",
      "CustomEvent",
      "EventTarget",
      "performance",
      "Performance",
      "PerformanceEntry",
      "PerformanceMark",
      "PerformanceMeasure",
    ],
    (operation) => {
      if (operation !== "clock") {
        throw new Error(`unexpected ${operation}`);
      }
      return JSON.stringify({
        ok: true,
        value: {
          timeOrigin: 1_700_000_000_000,
          now: clock.now,
        },
      });
    },
  ),
);

const performance = runtime.performance;

afterEach(() => {
  runtime.__fetchletClearPerformanceEntries();
  clock.now = 0;
});

describe("Performance", () => {
  test("reads the host clock and is an EventTarget", () => {
    clock.now = 12.5;
    expect(performance.now()).toBe(12.5);
    expect(performance.timeOrigin).toBe(1_700_000_000_000);
    expect(performance.toJSON()).toStrictEqual({ timeOrigin: 1_700_000_000_000 });
    expect(performance).toBeInstanceOf(runtime.Performance);
    expect(performance).toBeInstanceOf(runtime.EventTarget);
    expect(() => new runtime.Performance()).toThrow("Illegal constructor");
    expect(() => new runtime.PerformanceEntry()).toThrow("Illegal constructor");
    expect(() => new runtime.PerformanceMeasure()).toThrow("Illegal constructor");
  });

  test("mark records the current time, or a given one, with a cloned detail", () => {
    clock.now = 5;
    const detail = { step: 1 };
    const mark = performance.mark("start", { detail });
    expect(mark).toBeInstanceOf(runtime.PerformanceMark);
    expect(mark.toJSON()).toStrictEqual({
      name: "start",
      entryType: "mark",
      startTime: 5,
      duration: 0,
      detail: { step: 1 },
    });
    expect(mark.detail).not.toBe(detail);
    expect(performance.mark("given", { startTime: 2 }).startTime).toBe(2);
    expect(performance.mark("plain").detail).toBeNull();
    expect(() => performance.mark("negative", { startTime: -1 })).toThrow(TypeError);
    expect(new runtime.PerformanceMark("standalone").startTime).toBe(5);
    expect(performance.getEntriesByName("standalone")).toStrictEqual([]);
  });

  test("measure resolves marks, timestamps and options", () => {
    clock.now = 10;
    performance.mark("a");
    clock.now = 25;
    performance.mark("b");
    clock.now = 40;
    const span = (...args: unknown[]) => {
      const measure = performance.measure(...args);
      return [measure.startTime, measure.duration];
    };
    expect(span("all")).toStrictEqual([0, 40]);
    expect(span("from a", "a")).toStrictEqual([10, 30]);
    expect(span("a to b", "a", "b")).toStrictEqual([10, 15]);
    expect(span("options", { start: "a", end: "b" })).toStrictEqual([10, 15]);
    expect(span("numbers", { start: 3, end: 8 })).toStrictEqual([3, 5]);
    expect(span("start and duration", { start: "a", duration: 4 })).toStrictEqual([10, 4]);
    expect(span("end and duration", { end: "b", duration: 5 })).toStrictEqual([20, 5]);
    expect(span("to now from options", { start: "b" })).toStrictEqual([25, 15]);
    const measure = performance.measure("detail", { start: "a", detail: [1] });
    expect(measure).toBeInstanceOf(runtime.PerformanceMeasure);
    expect(measure.detail).toStrictEqual([1]);
    expect(measure.entryType).toBe("measure");
  });

  test("measure rejects unknown marks and conflicting options", () => {
    expect(() => performance.measure("missing", "nope")).toThrow(
      expect.objectContaining({ name: "SyntaxError" }),
    );
    expect(() => performance.measure("both", { start: 1 }, "end")).toThrow(TypeError);
    expect(() => performance.measure("detail only", { detail: 1 })).toThrow(TypeError);
    expect(() => performance.measure("three", { start: 1, end: 2, duration: 1 })).toThrow(
      TypeError,
    );
    expect(() => performance.measure("negative", { start: -1 })).toThrow(TypeError);
  });

  test("entries are listed by start time and cleared by name or type", () => {
    clock.now = 30;
    performance.mark("late");
    performance.mark("early", { startTime: 1 });
    performance.measure("span", "early", "late");
    expect(performance.getEntries().map((entry: any) => entry.name)).toStrictEqual([
      "early",
      "span",
      "late",
    ]);
    expect(performance.getEntriesByType("mark").map((entry: any) => entry.name)).toStrictEqual([
      "early",
      "late",
    ]);
    expect(performance.getEntriesByName("span", "mark")).toStrictEqual([]);
    performance.clearMarks("late");
    expect(performance.getEntriesByType("mark").map((entry: any) => entry.name)).toStrictEqual([
      "early",
    ]);
    performance.clearMeasures();
    performance.clearMarks();
    expect(performance.getEntries()).toStrictEqual([]);
  });

  test("the end of an invocation clears its entries", () => {
    performance.mark("request");
    runtime.__fetchletClearPerformanceEntries();
    expect(performance.getEntries()).toStrictEqual([]);
  });
});
