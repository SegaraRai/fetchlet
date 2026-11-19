import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { cryptoCall, domException, fromBase64, randomBytes, toBase64 } from "./host.ts";

// The bridge's claim, offered before the modules load. Each test sets the
// operation function it delegates to.
const stand = vi.hoisted(() => {
  const stand: {
    call?: (operation: string, input: string) => string;
  } = {};
  const missing = () => {
    throw new TypeError("No host in this test");
  };
  (globalThis as { __fetchletClaimHost?: unknown }).__fetchletClaimHost = () => ({
    call: (operation: string, input: string) => (stand.call ?? missing)(operation, input),
    putBytes: missing,
    takeBytes: missing,
  });
  return stand;
});

/** A fake host that answers every call with `reply` and records the calls. */
function host(reply: unknown) {
  const calls: [string, unknown][] = [];
  stand.call = (operation, input) => {
    calls.push([operation, JSON.parse(input)]);
    return JSON.stringify(reply);
  };
  return calls;
}

afterEach(() => {
  delete stand.call;
});

describe("base64", () => {
  test.each([
    [[], ""],
    [[0x66], "Zg=="],
    [[0x66, 0x6f], "Zm8="],
    [[0x66, 0x6f, 0x6f], "Zm9v"],
    [[0xff, 0xfe, 0xfd, 0xfc], "//79/A=="],
  ])("%o is %s", (bytes, text) => {
    expect(toBase64(new Uint8Array(bytes))).toBe(text);
    expect([...fromBase64(text)]).toStrictEqual(bytes);
  });

  test("round-trips every byte value as Node encodes it", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const text = toBase64(bytes);
    expect(text).toBe(Buffer.from(bytes).toString("base64"));
    expect(fromBase64(text)).toStrictEqual(bytes);
  });
});

describe("host calls", () => {
  test("randomBytes asks the host for the size and decodes its bytes", () => {
    const calls = host({
      ok: true,
      value: "AQID",
    });
    expect([...randomBytes(3)]).toStrictEqual([1, 2, 3]);
    expect(calls).toStrictEqual([["crypto.random", 3]]);
  });

  test("cryptoCall returns the operation's value", () => {
    const calls = host({
      ok: true,
      value: {
        value: "result",
      },
    });
    expect(
      cryptoCall("crypto.digest", {
        algorithm: "SHA-256",
      }),
    ).toBe("result");
    expect(calls).toStrictEqual([
      [
        "crypto.digest",
        {
          algorithm: "SHA-256",
        },
      ],
    ]);
  });

  test("a Web Cryptography error becomes a DOMException", () => {
    host({
      ok: true,
      value: {
        error: {
          name: "OperationError",
          message: "decryption failed",
        },
      },
    });
    const error = (() => {
      try {
        cryptoCall("crypto.decrypt", {});
      } catch (error) {
        return error;
      }
    })();
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "OperationError",
      message: "decryption failed",
    });
  });

  test("an invalid request is a TypeError and other host failures keep their code", () => {
    host({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "bad input",
      },
    });
    expect(() => cryptoCall("crypto.digest", {})).toThrow(new TypeError("bad input"));
    host({
      ok: false,
      error: {
        code: "LIMIT_EXCEEDED",
        message: "too large",
      },
    });
    expect(() => cryptoCall("crypto.digest", {})).toThrow(
      expect.objectContaining({
        name: "FetchletHostError",
        code: "LIMIT_EXCEEDED",
        message: "too large",
      }),
    );
  });

  test("domException uses the runtime's DOMException", () => {
    const error = domException("DataError", "bad key");
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("DataError");
  });
});

describe("hostProvides", () => {
  const load = async () => {
    vi.resetModules();
    return (await import("../runtime/web-host.ts")).hostProvides;
  };

  test("lists the APIs of a host that speaks this protocol, asking once", async () => {
    const calls = host({
      ok: true,
      value: {
        protocol: 3,
        apis: ["url", "crypto"],
      },
    });
    const hostProvides = await load();
    expect(hostProvides("url")).toBe(true);
    expect(hostProvides("crypto")).toBe(true);
    expect(hostProvides("compression")).toBe(false);
    expect(calls).toStrictEqual([["web.capabilities", null]]);
  });

  test("provides nothing without a host, with another protocol, or on an error", async () => {
    expect((await load())("url")).toBe(false);
    host({
      ok: true,
      value: {
        protocol: 1,
        apis: ["url"],
      },
    });
    expect((await load())("url")).toBe(false);
    host({
      ok: false,
      error: {
        code: "UNKNOWN_OPERATION",
        message: "",
      },
    });
    expect((await load())("url")).toBe(false);
    stand.call = () => "not json";
    expect((await load())("url")).toBe(false);
  });
});
