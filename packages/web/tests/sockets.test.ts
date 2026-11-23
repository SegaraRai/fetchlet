// connect() over a stand-in for the bridge's channel registry: argument
// checks, the byte streams, closes, refusals and a host without sockets.

import { describe, expect, test, vi } from "vite-plus/test";

import { runtime } from "../src/internal/runtime/runtime.ts";
import "../src/internal/foundation/foundation.ts";
import "../src/internal/dom/events.ts";
import { connect } from "../src/internal/sockets/sockets.ts";
import type { ChannelListener } from "../src/internal/websocket/websocket.ts";

vi.mock(import("../src/internal/runtime/runtime.ts"), async () => {
  const { fetchGlobals, isolatedRuntime } = await import("./isolated-runtime.ts");
  return isolatedRuntime([...fetchGlobals]);
});

/** A registry whose connections the test drives. */
function standIn(refuse?: string) {
  const addresses: unknown[] = [];
  const closes: unknown[][] = [];
  const writes: Uint8Array[] = [];
  let listener: ChannelListener | undefined;
  runtime.__fetchletChannels = {
    connect(address: unknown, given: ChannelListener) {
      if (refuse) {
        throw new TypeError(refuse);
      }
      addresses.push(address);
      listener = given;
      return 3;
    },
    write(_id: number, data: Uint8Array) {
      writes.push(data);
      return Promise.resolve();
    },
    pause: () => {},
    close: (...args: unknown[]) => closes.push(args),
    buffered: () => 0,
  };
  return {
    addresses,
    closes,
    writes,
    get listener(): ChannelListener {
      if (!listener) {
        throw new Error("no socket is open");
      }
      return listener;
    },
  };
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe("connect", () => {
  test("addresses are parsed and options checked", () => {
    const host = standIn();
    connect("db.example.test:5432");
    connect("[::1]:6379", { secureTransport: "on" });
    connect({ hostname: "example.test", port: 443 }, { allowHalfOpen: false });
    expect(host.addresses).toEqual([
      { hostname: "db.example.test", port: 5432, secureTransport: "off" },
      { hostname: "::1", port: 6379, secureTransport: "on" },
      { hostname: "example.test", port: 443, secureTransport: "off" },
    ]);
    for (const address of ["example.test", ":80", "example.test:0", "example.test:70000"]) {
      expect(() => connect(address), address).toThrow(TypeError);
    }
    expect(() => connect("example.test:1", { secureTransport: "starttls" })).toThrow(TypeError);
    expect(() => connect("example.test:1", { allowHalfOpen: true })).toThrow(TypeError);
    expect(() => connect("example.test:1", { secureTransport: "tls" as never })).toThrow(TypeError);
  });

  test("bytes flow both ways and a clean close resolves closed", async () => {
    const host = standIn();
    const socket = connect("db.example.test:5432");
    expect(socket.upgraded).toBe(false);
    expect(socket.secureTransport).toBe("off");
    expect(Object.prototype.toString.call(socket)).toBe("[object Socket]");
    expect(() => socket.startTls()).toThrow(TypeError);

    host.listener.open();
    await expect(socket.opened).resolves.toEqual({});

    const writer = socket.writable.getWriter();
    await writer.write(bytes(1, 2, 3));
    expect(host.writes).toEqual([bytes(1, 2, 3)]);

    const reader = socket.readable.getReader();
    host.listener.message(bytes(4, 5));
    expect(await reader.read()).toEqual({ done: false, value: bytes(4, 5) });

    host.listener.close(1000, "");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await expect(socket.closed).resolves.toBeUndefined();
  });

  test("close() asks the host to close and waits for it", async () => {
    const host = standIn();
    const socket = connect("db.example.test:5432");
    host.listener.open();
    const closed = socket.close();
    expect(host.closes).toEqual([[3, 1000, ""]]);
    host.listener.close(1000, "");
    await expect(closed).resolves.toBeUndefined();
  });

  test("an abnormal end rejects closed and errors the readable", async () => {
    const host = standIn();
    const socket = connect("db.example.test:5432");
    host.listener.open();
    const reader = socket.readable.getReader();
    host.listener.close(1011, "connection reset");
    await expect(reader.read()).rejects.toThrow("connection reset");
    await expect(socket.closed).rejects.toThrow("connection reset");
  });

  test("a failed connect rejects opened and closed", async () => {
    const host = standIn();
    const socket = connect("db.example.test:5432");
    host.listener.refused?.("connection refused");
    await expect(socket.opened).rejects.toThrow("connection refused");
    await expect(socket.closed).rejects.toThrow("connection refused");
  });

  test("a refused address fails the socket instead of throwing", async () => {
    standIn("host operation is not permitted");
    const socket = connect("elsewhere.test:25");
    await expect(socket.opened).rejects.toThrow("host operation is not permitted");
    await expect(socket.closed).rejects.toThrow("host operation is not permitted");
    await expect(socket.readable.getReader().read()).rejects.toThrow(TypeError);
    await expect(socket.close()).rejects.toThrow(TypeError);
  });

  test("a host without channels fails the socket", async () => {
    delete runtime.__fetchletChannels;
    const socket = connect("db.example.test:5432");
    await expect(socket.opened).rejects.toThrow("This host has no sockets");
  });
});
