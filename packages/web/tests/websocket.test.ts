// The client WebSocket over a stand-in for the bridge's channel registry:
// URL and subprotocol checks, the handshake's selection, messages, the
// closing handshake and connections that fail.

import { describe, expect, test, vi } from "vite-plus/test";

import type { ChannelListener } from "../src/internal/channels/registry.ts";
import "../src/internal/foundation/foundation.ts";
import "../src/internal/dom/events.ts";
import "../src/internal/html/message-channel.ts";
import { runtime } from "../src/internal/runtime/runtime.ts";
import { WebSocketImpl } from "../src/internal/websocket/websocket.ts";

vi.mock(import("../src/internal/runtime/runtime.ts"), async () => {
  const { fetchGlobals, isolatedRuntime } = await import("./isolated-runtime.ts");
  return isolatedRuntime([
    ...fetchGlobals,
    "MessageChannel",
    "MessagePort",
    "MessageEvent",
    "CloseEvent",
    "WebSocket",
  ]);
});

/** A registry whose connections the test drives, recording its calls. */
function standIn(refuse?: string) {
  const requests: unknown[] = [];
  const calls: unknown[][] = [];
  let listener: ChannelListener | undefined;
  runtime.__fetchletChannels = {
    websocket(request: unknown, given: ChannelListener) {
      if (refuse) {
        throw new TypeError(refuse);
      }
      requests.push(request);
      listener = given;
      return 5;
    },
    send: (...args: unknown[]) => calls.push(["send", ...args]),
    close: (...args: unknown[]) => calls.push(["close", ...args]),
    buffered: () => 3,
  };
  return {
    requests,
    calls,
    get listener(): ChannelListener {
      if (!listener) {
        throw new Error("no socket is open");
      }
      return listener;
    },
  };
}

/** Record the socket's events as strings. */
function record(socket: any): string[] {
  const events: string[] = [];
  socket.addEventListener("open", () => events.push("open"));
  socket.addEventListener("error", () => events.push("error"));
  socket.addEventListener("message", (event: any) =>
    events.push(
      `message:${typeof event.data === "string" ? event.data : "binary"}:${event.origin}`,
    ),
  );
  socket.addEventListener("close", (event: any) =>
    events.push(`close:${event.code}:${event.reason}:${event.wasClean}`),
  );
  return events;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("client WebSocket", () => {
  test("URLs and subprotocols are checked as the standard says", () => {
    const host = standIn();
    new WebSocketImpl("wss://example.test/chat?room=1", ["chat", "v2.json"]);
    new WebSocketImpl("https://example.test/plain");
    new WebSocketImpl("ws://example.test/", "single");
    expect(host.requests).toEqual([
      { url: "wss://example.test/chat?room=1", protocols: ["chat", "v2.json"] },
      { url: "wss://example.test/plain", protocols: [] },
      { url: "ws://example.test/", protocols: ["single"] },
    ]);
    for (const [url, protocols] of [
      ["not a url", undefined],
      ["ftp://example.test/", undefined],
      ["wss://example.test/#top", undefined],
      ["wss://example.test/#", undefined],
      ["wss://example.test/", ["a b"]],
      ["wss://example.test/", ["chat", "chat"]],
      ["wss://example.test/", [""]],
    ] as const) {
      expect(() => new WebSocketImpl(url, protocols), url).toThrow(
        expect.objectContaining({ name: "SyntaxError" }),
      );
    }
    expect(() => new (WebSocketImpl as any)()).toThrow(TypeError);
  });

  test("the handshake's selection, messages and the closing handshake", async () => {
    const host = standIn();
    const socket = new WebSocketImpl("wss://example.test/chat", ["chat", "v2"]);
    const events = record(socket);
    expect(socket.readyState).toBe(WebSocketImpl.CONNECTING);
    expect(socket.url).toBe("wss://example.test/chat");
    expect(() => socket.send("early")).toThrow(
      expect.objectContaining({ name: "InvalidStateError" }),
    );

    host.listener.open({ protocol: "v2", extensions: "permessage-deflate" });
    expect(socket.readyState).toBe(WebSocketImpl.OPEN);
    expect(socket.protocol).toBe("v2");
    expect(socket.extensions).toBe("permessage-deflate");
    expect(socket.bufferedAmount).toBe(3);

    socket.send("hello");
    socket.send(new Uint8Array([1, 2]));
    host.listener.message("hi");
    host.listener.message(new Uint8Array([3]));
    socket.close(1000, "done");
    expect(socket.readyState).toBe(WebSocketImpl.CLOSING);
    host.listener.close(1000, "done");
    await settle();
    expect(socket.readyState).toBe(WebSocketImpl.CLOSED);
    expect(host.calls).toEqual([
      ["send", 5, "hello"],
      ["send", 5, new Uint8Array([1, 2])],
      ["close", 5, 1000, "done"],
    ]);
    expect(events).toEqual([
      "open",
      "message:hi:wss://example.test",
      "message:binary:wss://example.test",
      "close:1000:done:true",
    ]);
  });

  test("a failed handshake errors and closes with 1006", async () => {
    const host = standIn();
    const socket = new WebSocketImpl("wss://example.test/");
    const events = record(socket);
    host.listener.refused?.("host transport failed");
    expect(socket.readyState).toBe(WebSocketImpl.CLOSED);
    expect(events).toEqual(["error", "close:1006::false"]);
  });

  test("closing while connecting fails the connection", () => {
    const host = standIn();
    const socket = new WebSocketImpl("wss://example.test/");
    const events = record(socket);
    socket.close();
    expect(host.calls).toEqual([["close", 5, 1000, ""]]);
    // The host abandons the handshake.
    host.listener.close(1006, "");
    expect(events).toEqual(["error", "close:1006::false"]);
  });

  test("a refused origin or a host without WebSockets fails after the constructor", async () => {
    standIn("host operation is not permitted");
    const refused = new WebSocketImpl("wss://elsewhere.test/");
    const events = record(refused);
    expect(refused.readyState).toBe(WebSocketImpl.CONNECTING);
    await settle();
    expect(events).toEqual(["error", "close:1006::false"]);

    delete runtime.__fetchletChannels;
    const absent = new WebSocketImpl("wss://example.test/");
    const absentEvents = record(absent);
    await settle();
    expect(absentEvents).toEqual(["error", "close:1006::false"]);
    expect(absent.bufferedAmount).toBe(0);
  });
});
