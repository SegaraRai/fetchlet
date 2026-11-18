// node:buffer, node:process and node:timers against Node where their
// behavior is defined to match, and their fetchlet-specific values.

import * as nodeBuffer from "node:buffer";

import buffer, { Buffer, isAscii, isUtf8 } from "@fetchlet/node/buffer";
import process from "@fetchlet/node/process";
import timers from "@fetchlet/node/timers";
import timersPromises from "@fetchlet/node/timers/promises";
import { describe, expect, test, vi } from "vite-plus/test";

describe("buffer", () => {
  test("encodes and decodes like Node", () => {
    const text = "fetchlet é€\u{1f600}";
    for (const encoding of ["utf8", "hex", "base64", "base64url", "latin1", "utf16le"] as const) {
      expect(Buffer.from(text).toString(encoding)).toBe(
        nodeBuffer.Buffer.from(text).toString(encoding),
      );
    }
    expect([...Buffer.from("68656c6c6f", "hex")]).toStrictEqual([
      ...nodeBuffer.Buffer.from("68656c6c6f", "hex"),
    ]);
    const ours = Buffer.alloc(8);
    const theirs = nodeBuffer.Buffer.alloc(8);
    ours.writeDoubleBE(1.5);
    theirs.writeDoubleBE(1.5);
    expect([...ours]).toStrictEqual([...theirs]);
    expect(Buffer.isBuffer(ours)).toBe(true);
  });

  test("isUtf8, isAscii and the constants match Node", () => {
    const samples = [
      new Uint8Array([0x61]),
      new Uint8Array([0xc3, 0xa9]),
      new Uint8Array([0xff]),
      new Uint8Array(),
    ];
    expect(samples.map((sample) => isUtf8(sample))).toStrictEqual(
      samples.map((sample) => nodeBuffer.isUtf8(sample)),
    );
    expect(samples.map((sample) => isAscii(sample))).toStrictEqual(
      samples.map((sample) => nodeBuffer.isAscii(sample)),
    );
    expect(buffer.constants.MAX_STRING_LENGTH).toBe(buffer.kStringMaxLength);
    expect(typeof buffer.constants.MAX_LENGTH).toBe("number");
  });

  test("reexports the Web globals", () => {
    expect(buffer.Blob).toBe(globalThis.Blob);
    expect(buffer.atob("aGk=")).toBe("hi");
    expect(buffer.btoa("hi")).toBe("aGk=");
  });
});

describe("process", () => {
  test("describes an instance without Node", () => {
    expect(process.versions).toStrictEqual({});
    // Libraries detect Node by this tag and would leave their Web paths.
    expect(Object.prototype.toString.call(process)).toBe("[object Object]");
    expect(process.version).toBe("");
    expect(process.cwd()).toBe("/");
    expect(process.env.NODE_ENV).toBe("production");
    expect(process.platform).toBe("linux");
  });

  test("nextTick runs callbacks with their arguments before timers", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("timeout"), 0);
    process.nextTick((value: string) => order.push(value), "tick");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toStrictEqual(["tick", "timeout"]);
  });

  test("hrtime measures forward and bigint agrees", () => {
    const start = process.hrtime();
    const [seconds, nanoseconds] = process.hrtime(start);
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(nanoseconds).toBeGreaterThanOrEqual(0);
    expect(typeof process.hrtime.bigint()).toBe("bigint");
  });

  test("emitWarning reaches warning listeners", async () => {
    const warnings: string[] = [];
    const listener = (warning: Error) => warnings.push(`${warning.name}: ${warning.message}`);
    process.on("warning", listener);
    process.emitWarning("careful", "ExperimentalWarning");
    await Promise.resolve();
    process.off("warning", listener);
    expect(warnings).toStrictEqual(["ExperimentalWarning: careful"]);
  });

  test("exit throws a clear error", () => {
    expect(() => process.exit(1)).toThrow("is not available in fetchlet");
  });
});

describe("timers", () => {
  test("Timeout objects clear, refresh and convert to their id", async () => {
    const calls = vi.fn();
    const timeout = timers.setTimeout(calls, 1, "a");
    expect(timeout.hasRef()).toBe(true);
    expect(timeout.unref().hasRef()).toBe(false);
    expect(typeof +timeout).toBe("number");
    timers.clearTimeout(timeout);
    const kept = timers.setTimeout(calls, 1, "b");
    kept.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.mock.calls).toStrictEqual([["b"]]);
  });

  test("intervals repeat until cleared by id", async () => {
    let count = 0;
    const interval = timers.setInterval(() => {
      count += 1;
      if (count === 3) {
        timers.clearInterval(+interval);
      }
    }, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(count).toBe(3);
  });

  test("setImmediate runs after microtasks and can be cleared", async () => {
    const order: string[] = [];
    timers.setImmediate(() => order.push("immediate"));
    const cleared = timers.setImmediate(() => order.push("cleared"));
    timers.clearImmediate(cleared);
    queueMicrotask(() => order.push("microtask"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toStrictEqual(["microtask", "immediate"]);
  });

  test("timers/promises resolves values and rejects on abort", async () => {
    expect(await timersPromises.setTimeout(1, "value")).toBe("value");
    expect(await timersPromises.setImmediate("now")).toBe("now");
    const controller = new AbortController();
    const waiting = timersPromises.setTimeout(1000, undefined, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    const ticks: number[] = [];
    for await (const value of timersPromises.setInterval(1, 7)) {
      ticks.push(value);
      if (ticks.length === 2) {
        break;
      }
    }
    expect(ticks).toStrictEqual([7, 7]);
  });
});
