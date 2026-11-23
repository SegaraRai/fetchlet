// Channels of env bindings over a stand-in for the bridge's channel
// registry: the WebSocket view, the byte stream view, refusals and the
// arrivals that precede a view.

import { describe, expect, test, vi } from "vite-plus/test";

import { connectChannel } from "../src/internal/channels/host-channel.ts";
import "../src/internal/foundation/foundation.ts";
import "../src/internal/dom/events.ts";
import "../src/internal/html/message-channel.ts";
import type { ChannelListener } from "../src/internal/channels/registry.ts";
import { runtime } from "../src/internal/runtime/runtime.ts";

vi.mock(import("../src/internal/runtime/runtime.ts"), async () => {
  const { fetchGlobals, isolatedRuntime } = await import("./isolated-runtime.ts");
  return isolatedRuntime([
    ...fetchGlobals,
    "MessageChannel",
    "MessagePort",
    "MessageEvent",
    "CloseEvent",
  ]);
});

interface Call {
  operation: string;
  args: unknown[];
}

/** A registry with one channel, whose arrivals the test delivers. */
function standIn() {
  const calls: Call[] = [];
  let listener: ChannelListener | undefined;
  const writes: { data: Uint8Array; resolve(): void }[] = [];
  runtime.__fetchletChannels = {
    open(service: string, options: unknown, given: ChannelListener) {
      calls.push({ operation: "open", args: [service, options] });
      listener = given;
      return 7;
    },
    send: (...args: unknown[]) => calls.push({ operation: "send", args }),
    write(_id: number, data: Uint8Array) {
      return new Promise<void>((resolve) => writes.push({ data, resolve }));
    },
    pause: (...args: unknown[]) => calls.push({ operation: "pause", args }),
    close: (...args: unknown[]) => calls.push({ operation: "close", args }),
    buffered: () => 0,
  };
  return {
    calls,
    writes,
    get listener(): ChannelListener {
      if (!listener) {
        throw new Error("no channel is open");
      }
      return listener;
    },
  };
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe("host channels", () => {
  test("the Web API profile builds env bindings' channels", () => {
    expect(typeof runtime.__fetchletChannelViews.connect).toBe("function");
    expect(Object.getOwnPropertyDescriptor(runtime, "__fetchletChannelViews")?.writable).toBe(
      false,
    );
  });

  test("the WebSocket view opens, exchanges messages and closes", async () => {
    const host = standIn();
    const channel = connectChannel("ECHO", { room: 1 });
    expect(host.calls[0]).toEqual({ operation: "open", args: ["ECHO", { room: 1 }] });
    const socket = channel.socket();
    const events: string[] = [];
    socket.addEventListener("open", () => events.push("open"));
    socket.addEventListener("message", (event: any) => events.push(`message:${event.data}`));
    socket.addEventListener("close", (event: any) =>
      events.push(`close:${event.code}:${event.reason}:${event.wasClean}`),
    );
    expect(socket.readyState).toBe(0);
    expect(() => socket.send("early")).toThrow();

    host.listener.open();
    await channel.opened;
    expect(socket.readyState).toBe(1);
    socket.send("hi");
    host.listener.message("echo:hi");
    socket.close(1000, "done");
    host.listener.close(1000, "done");
    expect(await channel.closed).toEqual({ code: 1000, reason: "done" });
    expect(events).toEqual(["open", "message:echo:hi", "close:1000:done:true"]);
    expect(host.calls.slice(1)).toEqual([
      { operation: "send", args: [7, "hi"] },
      { operation: "close", args: [7, 1000, "done"] },
    ]);
  });

  test("a refused open rejects opened and fails the view", async () => {
    const host = standIn();
    const channel = connectChannel("REFUSE");
    const socket = channel.socket();
    const events: string[] = [];
    socket.addEventListener("error", () => events.push("error"));
    socket.addEventListener("close", (event: any) => events.push(`close:${event.code}`));
    host.listener.refused?.("host operation is not permitted");
    await expect(channel.opened).rejects.toThrow("host operation is not permitted");
    expect(await channel.closed).toEqual({ code: 1006, reason: "" });
    expect(events).toEqual(["error", "close:1006"]);
  });

  test("a channel takes one view", () => {
    standIn();
    const channel = connectChannel("ECHO");
    channel.stream();
    expect(() => channel.socket()).toThrow(TypeError);
    expect(() => channel.stream()).toThrow(TypeError);
  });

  test("arrivals before a view reach the view taken later", async () => {
    const host = standIn();
    const channel = connectChannel("ECHO");
    host.listener.open();
    host.listener.message(bytes(1, 2));
    await channel.opened;
    const reader = channel.stream().readable.getReader();
    expect(await reader.read()).toEqual({ value: bytes(1, 2), done: false });
  });

  test("the stream view reads binary messages with backpressure and writes after the open", async () => {
    const host = standIn();
    const channel = connectChannel("ECHO");
    const { readable, writable } = channel.stream();
    const writer = writable.getWriter();
    const written = writer.write(bytes(9, 8));
    // Nothing is written before the service accepts the open.
    await Promise.resolve();
    expect(host.writes).toHaveLength(0);
    host.listener.open();
    await vi.waitFor(() => expect(host.writes).toHaveLength(1));
    expect(host.writes[0]?.data).toEqual(bytes(9, 8));
    host.writes[0]?.resolve();
    await written;

    // The reader has room for one chunk; the second pauses the channel.
    host.listener.message(bytes(1));
    host.listener.message(bytes(2));
    expect(host.calls.filter((call) => call.operation === "pause")).toEqual([
      { operation: "pause", args: [7, true] },
    ]);
    const reader = readable.getReader();
    expect(await reader.read()).toEqual({ value: bytes(1), done: false });
    expect(await reader.read()).toEqual({ value: bytes(2), done: false });
    await vi.waitFor(() =>
      expect(host.calls.filter((call) => call.operation === "pause")).toContainEqual({
        operation: "pause",
        args: [7, false],
      }),
    );
    host.listener.close(1000, "");
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  });

  test("a text message fails the stream view", async () => {
    const host = standIn();
    const channel = connectChannel("ECHO");
    const reader = channel.stream().readable.getReader();
    host.listener.open();
    host.listener.message("text");
    await expect(reader.read()).rejects.toThrow(TypeError);
    expect(host.calls).toContainEqual({
      operation: "close",
      args: [7, 1003, "text message on a byte stream"],
    });
  });
});
