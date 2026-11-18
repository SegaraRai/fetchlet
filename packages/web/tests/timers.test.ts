// The timer queue the profile installs on engines without timers. The host
// asks for the next delay and runs due timers one at a time; the tests drive
// those hooks with a fake clock.

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { runtime } from "../src/runtime.ts";
import "../src/timers.ts";

vi.mock(import("../src/runtime.ts"), async () =>
  (await import("./isolated-runtime.ts")).isolatedRuntime([
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
  ]),
);

const runNext = (): boolean => runtime.__fetchletRunNextTimer();
const delay = (): number => runtime.__fetchletTimerDelay();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  runtime.__fetchletClearTimers();
  vi.useRealTimers();
});

describe("the profile's timers", () => {
  test("are installed on the runtime only", () => {
    expect(runtime.setTimeout).not.toBe(globalThis.setTimeout);
    expect(typeof runtime.setTimeout).toBe("function");
  });

  test("report the delay to the earliest timer, or -1 without one", () => {
    expect(delay()).toBe(-1);
    runtime.setTimeout(() => {}, 50);
    runtime.setTimeout(() => {}, 20);
    expect(delay()).toBe(20);
    vi.setSystemTime(1_000_030);
    expect(delay()).toBe(0);
  });

  test("run due timers in due order, one per call, with their arguments", () => {
    const order: unknown[] = [];
    runtime.setTimeout((value: string) => order.push(value), 20, "late");
    runtime.setTimeout((value: string) => order.push(value), 10, "early");
    runtime.setTimeout((value: string) => order.push(value), 10, "early, second");
    expect(runNext()).toBe(false);
    vi.setSystemTime(1_000_020);
    expect([runNext(), runNext(), runNext(), runNext()]).toStrictEqual([true, true, true, false]);
    expect(order).toStrictEqual(["early", "early, second", "late"]);
  });

  test("negative and invalid delays run as soon as possible", () => {
    const ran: string[] = [];
    runtime.setTimeout(() => ran.push("negative"), -5);
    runtime.setTimeout(() => ran.push("text"), "soon");
    runtime.setTimeout(() => ran.push("default"));
    expect(delay()).toBe(0);
    while (runNext()) {}
    expect(ran).toStrictEqual(["negative", "text", "default"]);
  });

  test("intervals reschedule before running, so they can clear themselves", () => {
    let count = 0;
    const id: number = runtime.setInterval(() => {
      count += 1;
      if (count === 3) {
        runtime.clearInterval(id);
      }
    }, 10);
    for (let step = 1; step <= 5; step += 1) {
      vi.setSystemTime(1_000_000 + step * 10);
      runNext();
    }
    expect(count).toBe(3);
    expect(delay()).toBe(-1);
  });

  test("timeouts and intervals share identifiers, so either clear cancels either", () => {
    const ran: string[] = [];
    const timeout: number = runtime.setTimeout(() => ran.push("timeout"), 0);
    const interval: number = runtime.setInterval(() => ran.push("interval"), 0);
    expect(interval).toBeGreaterThan(timeout);
    runtime.clearInterval(timeout);
    runtime.clearTimeout(interval);
    expect(runNext()).toBe(false);
    expect(ran).toStrictEqual([]);
  });

  test("clearing all timers ends pending intervals", () => {
    runtime.setInterval(() => {}, 5);
    runtime.setTimeout(() => {}, 5);
    runtime.__fetchletClearTimers();
    expect(delay()).toBe(-1);
  });

  test("a callback must be a function", () => {
    expect(() => runtime.setTimeout("code()", 0)).toThrow("Expected callback");
  });
});
