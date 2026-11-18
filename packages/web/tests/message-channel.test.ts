// MessageChannel within one instance: structured clones delivered as tasks
// once a port is started.

import { describe, expect, test, vi } from "vite-plus/test";

import "../src/internal/dom/events.ts";
import "../src/internal/html/message-channel.ts";
import { runtime } from "../src/internal/runtime/runtime.ts";

vi.mock(import("../src/internal/runtime/runtime.ts"), async () =>
  (await import("./isolated-runtime.ts")).isolatedRuntime([
    "Event",
    "CustomEvent",
    "EventTarget",
    "MessageChannel",
    "MessagePort",
    "MessageEvent",
  ]),
);

/** Lets queued message tasks run: each delivery queues the next as a task. */
async function tasks() {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function received(port: any): unknown[] {
  const data: unknown[] = [];
  port.onmessage = (event: any) => data.push(event.data);
  return data;
}

describe("MessageChannel", () => {
  test("delivers clones in order after the current task", async () => {
    const { port1, port2 } = new runtime.MessageChannel();
    const data = received(port2);
    const message = { nested: [1, 2] };
    port1.postMessage(message);
    port1.postMessage("second");
    expect(data).toStrictEqual([]);
    await tasks();
    expect(data).toStrictEqual([{ nested: [1, 2] }, "second"]);
    expect(data[0]).not.toBe(message);
  });

  test("delivers after promise jobs, as schedulers expect of a task", async () => {
    const { port1, port2 } = new runtime.MessageChannel();
    const order: string[] = [];
    port2.onmessage = () => order.push("message");
    port1.postMessage(null);
    void Promise.resolve().then(() => order.push("microtask"));
    await tasks();
    expect(order).toStrictEqual(["microtask", "message"]);
  });

  test("messages wait for start() when listeners use addEventListener", async () => {
    const { port1, port2 } = new runtime.MessageChannel();
    const events: any[] = [];
    port2.addEventListener("message", (event: any) => events.push(event));
    port1.postMessage("queued");
    await tasks();
    expect(events).toStrictEqual([]);
    port2.start();
    await tasks();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(runtime.MessageEvent);
    expect([events[0].data, events[0].isTrusted, events[0].origin, events[0].ports]).toStrictEqual([
      "queued",
      true,
      "",
      [],
    ]);
  });

  test("both directions work", async () => {
    const { port1, port2 } = new runtime.MessageChannel();
    const one = received(port1);
    const two = received(port2);
    port1.postMessage("to two");
    port2.postMessage("to one");
    await tasks();
    expect([one, two]).toStrictEqual([["to one"], ["to two"]]);
  });

  test("close disentangles the ports and drops queued messages", async () => {
    const { port1, port2 } = new runtime.MessageChannel();
    const data = received(port2);
    port1.postMessage("dropped");
    port2.close();
    port1.postMessage("after close");
    await tasks();
    expect(data).toStrictEqual([]);
    expect(() => port2.postMessage("still clones")).not.toThrow();
  });

  test("an exception in a listener does not stop later messages", async () => {
    const { port1, port2 } = new runtime.MessageChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const data: unknown[] = [];
    port2.onmessage = (event: any) => {
      data.push(event.data);
      throw new Error("listener");
    };
    port1.postMessage(1);
    port1.postMessage(2);
    await tasks();
    expect(data).toStrictEqual([1, 2]);
    error.mockRestore();
  });

  test("uncloneable messages and port transfers throw DataCloneError", () => {
    const { port1, port2 } = new runtime.MessageChannel();
    expect(() => port1.postMessage(() => {})).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    expect(() => port1.postMessage(null, [port2])).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    expect(() => port1.postMessage(null, { transfer: [port2] })).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    expect(() => port1.postMessage()).toThrow(TypeError);
  });

  test("ports come only from a channel", () => {
    expect(() => new runtime.MessagePort()).toThrow("Illegal constructor");
    const channel = new runtime.MessageChannel();
    expect(channel.port1).toBeInstanceOf(runtime.MessagePort);
    expect(channel.port1).toBeInstanceOf(runtime.EventTarget);
    expect(channel.port1).toBe(channel.port1);
    expect(Object.prototype.toString.call(channel)).toBe("[object MessageChannel]");
  });
});

describe("MessageEvent", () => {
  test("converts its init dictionary", () => {
    const { port1 } = new runtime.MessageChannel();
    const event = new runtime.MessageEvent("message", {
      data: { a: 1 },
      origin: "https://app.test",
      lastEventId: "7",
      source: port1,
      ports: [port1],
    });
    expect([event.data, event.origin, event.lastEventId, event.source]).toStrictEqual([
      { a: 1 },
      "https://app.test",
      "7",
      port1,
    ]);
    expect(event.ports).toStrictEqual([port1]);
    expect(Object.isFrozen(event.ports)).toBe(true);
    expect(new runtime.MessageEvent("message").data).toBeNull();
    expect(() => new runtime.MessageEvent("message", { source: {} })).toThrow(TypeError);
    expect(() => new runtime.MessageEvent("message", { ports: [{}] })).toThrow(TypeError);
  });
});
