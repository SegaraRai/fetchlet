// connect() over a stand-in for the bridge's channel registry: argument
// checks, the byte streams, half closes, startTls, closes, refusals and a
// host without sockets.

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

/** A registry whose connections the test drives, recording its calls. */
function standIn(refuse?: string) {
  const addresses: unknown[] = [];
  const calls: string[] = [];
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
      calls.push(`write:${data.join(",")}`);
      return Promise.resolve();
    },
    pause: () => {},
    close: (id: number, code: number) => calls.push(`close:${id}:${code}`),
    endWrites: (id: number) => calls.push(`end:${id}`),
    startTls: (id: number) => calls.push(`startTls:${id}`),
    buffered: () => 0,
  };
  return {
    addresses,
    calls,
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("connect", () => {
  test("addresses are parsed and options checked", () => {
    const host = standIn();
    connect("db.example.test:5432");
    connect("[::1]:6379", { secureTransport: "on" });
    connect({ hostname: "example.test", port: 25 }, { secureTransport: "starttls" });
    connect("example.test:80", { allowHalfOpen: true });
    expect(host.addresses).toEqual([
      { hostname: "db.example.test", port: 5432, secureTransport: "off" },
      { hostname: "::1", port: 6379, secureTransport: "on" },
      { hostname: "example.test", port: 25, secureTransport: "starttls" },
      { hostname: "example.test", port: 80, secureTransport: "off" },
    ]);
    for (const address of ["example.test", ":80", "example.test:0", "example.test:70000"]) {
      expect(() => connect(address), address).toThrow(TypeError);
    }
    expect(() => connect("example.test:1", { secureTransport: "tls" as never })).toThrow(TypeError);
  });

  test("bytes flow both ways and the peer's end closes both directions", async () => {
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

    // Without half-open, the peer's end also ends the writes.
    host.listener.end?.();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await settle();
    expect(host.calls).toEqual(["write:1,2,3", "end:3"]);
    await expect(writer.write(bytes(6))).rejects.toThrow(TypeError);

    host.listener.close(1000, "");
    await expect(socket.closed).resolves.toBeUndefined();
  });

  test("a half-open socket writes after the peer's end until it closes its writable", async () => {
    const host = standIn();
    const socket = connect("db.example.test:5432", { allowHalfOpen: true });
    host.listener.open();
    const reader = socket.readable.getReader();
    host.listener.end?.();
    expect(await reader.read()).toEqual({ done: true, value: undefined });

    const writer = socket.writable.getWriter();
    await writer.write(bytes(7));
    await writer.close();
    expect(host.calls).toEqual(["write:7", "end:3"]);
    host.listener.close(1000, "");
    await expect(socket.closed).resolves.toBeUndefined();
  });

  test("closing the writable ends the writes and keeps reading", async () => {
    const host = standIn();
    const socket = connect("db.example.test:5432");
    host.listener.open();
    await socket.writable.close();
    expect(host.calls).toEqual(["end:3"]);
    const reader = socket.readable.getReader();
    host.listener.message(bytes(9));
    expect(await reader.read()).toEqual({ done: false, value: bytes(9) });
  });

  test("close() asks the host to close and waits for it", async () => {
    const host = standIn();
    const socket = connect("db.example.test:5432");
    const closed = socket.close();
    expect(host.calls).toEqual(["close:3:1000"]);
    // Closed before it opened, the connection is abandoned.
    host.listener.close(1006, "");
    await expect(closed).resolves.toBeUndefined();
    await expect(socket.opened).rejects.toThrow(TypeError);
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

  test("startTls hands the connection to a secure socket after the plain writes", async () => {
    const host = standIn();
    const plain = connect("mail.example.test:25", { secureTransport: "starttls" });
    host.listener.open();
    await settle();
    // A write in flight goes out before TLS starts.
    const plainWriter = plain.writable.getWriter();
    const written = plainWriter.write(bytes(1));
    const secure = plain.startTls();
    expect(plain.upgraded).toBe(true);
    expect(secure.secureTransport).toBe("on");
    expect(() => plain.startTls()).toThrow(TypeError);
    await written;
    await expect(plain.closed).resolves.toBeUndefined();
    expect(await plain.readable.getReader().read()).toEqual({ done: true, value: undefined });
    expect(host.calls).toEqual(["write:1", "startTls:3"]);

    // The secure socket writes once TLS is up.
    const secureWriter = secure.writable.getWriter();
    const secureWrite = secureWriter.write(bytes(2));
    await settle();
    expect(host.calls).toEqual(["write:1", "startTls:3"]);
    host.listener.secure?.();
    await expect(secure.opened).resolves.toEqual({});
    await secureWrite;
    expect(host.calls).toEqual(["write:1", "startTls:3", "write:2"]);

    const reader = secure.readable.getReader();
    host.listener.message(bytes(3));
    expect(await reader.read()).toEqual({ done: false, value: bytes(3) });
    await expect(plainWriter.write(bytes(4))).rejects.toThrow(TypeError);

    const closed = secure.close();
    expect(host.calls.at(-1)).toBe("close:3:1000");
    host.listener.close(1000, "");
    await expect(closed).resolves.toBeUndefined();
  });

  test("a failed handshake fails the secure socket", async () => {
    const host = standIn();
    const plain = connect("mail.example.test:25", { secureTransport: "starttls" });
    host.listener.open();
    const secure = plain.startTls();
    await settle();
    host.listener.close(1011, "TLS handshake failed");
    await expect(secure.opened).rejects.toThrow("TLS handshake failed");
    await expect(secure.closed).rejects.toThrow("TLS handshake failed");
    await expect(plain.closed).resolves.toBeUndefined();
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
