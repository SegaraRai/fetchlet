import { afterEach, expect, test, vi } from "vite-plus/test";

// The bridge's claim, offered before the modules load. Each test sets the
// operation function, which replies JSON text so that the fake host itself
// passes nothing through the built-in functions the test replaces.
const stand = vi.hoisted(() => {
  const stand: { call?: (operation: string, input: any) => string } = {};
  const parse = JSON.parse;
  (globalThis as { __fetchletClaimHost?: unknown }).__fetchletClaimHost = () =>
    Object.freeze({
      call: (operation: string, input: string) =>
        '{"ok":true,"value":{"value":' + stand.call!(operation, parse(input)) + "}}",
      putBytes() {},
      takeBytes() {},
    });
  return stand;
});

import type { CryptoKey } from "./key.ts";
import { createSubtle } from "./subtle.ts";

const subtle = createSubtle();
const secret = new TextEncoder().encode("SECRET-KEY-MATERIAL!");
const secretBase64 = Buffer.from(secret).toString("base64");
const secretBase64url = Buffer.from(secret).toString("base64url");
/** What any encoding of the secret in this test contains. */
const markers = ["SECRET-KEY-MATERIAL", secretBase64url.slice(0, 24)];
/** A wrapped JSON Web Key, which the fake host unwraps from the bytes 0 0 0. */
const wrappedJwk = Buffer.from(JSON.stringify({ kty: "oct", k: secretBase64url })).toString(
  "base64",
);

/** A fake host whose keys, derived bits and unwrapped keys are the secret. */
function fakeHost(operation: string, input: any): string {
  const key = (data: string) =>
    '{"key":{"type":"secret","data":"' + data + '"},"algorithm":{"length":160}}';
  switch (operation) {
    case "crypto.generateKey":
      return key(secretBase64);
    case "crypto.importKey":
      return key(typeof input.data === "string" ? input.data : secretBase64);
    case "crypto.deriveBits":
      return '"' + secretBase64 + '"';
    case "crypto.decrypt":
      return '"' + (input.data === "AAAA" ? wrappedJwk : secretBase64) + '"';
    default:
      return '"AAAA"';
  }
}

afterEach(() => {
  delete stand.call;
});

/**
 * Replace the built-in functions and accessors key material could pass
 * through with spies that record what they see, run `body`, and restore
 * them.
 */
async function spyOnBuiltIns(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const restore: (() => void)[] = [];
  const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf } = Object;
  const { apply } = Reflect;
  const replaceMethod = (target: any, name: PropertyKey) => {
    const original = target[name];
    target[name] = function (this: unknown, ...values: unknown[]) {
      const result = apply(original, this, values);
      seen.push(this, values, result);
      return result;
    };
    restore.push(() => (target[name] = original));
  };
  const replaceGetter = (target: object, name: PropertyKey) => {
    const descriptor = getOwnPropertyDescriptor(target, name)!;
    defineProperty(target, name, {
      ...descriptor,
      get(this: unknown) {
        seen.push(this);
        // eslint-disable-next-line typescript/unbound-method -- apply supplies the receiver
        return apply(descriptor.get!, this, []);
      },
    });
    restore.push(() => defineProperty(target, name, descriptor));
  };
  // Members that the messages and JSON Web Keys do not always have.
  for (const name of ["toJSON", "error", "key", "publicKey", "k", "kty", "alg", "use", "d"]) {
    defineProperty(Object.prototype, name, {
      get(this: unknown) {
        seen.push(this);
        return undefined;
      },
      set(this: object, value: unknown) {
        seen.push(this, value);
        defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
      },
      configurable: true,
    });
    restore.push(() => delete (Object.prototype as any)[name]);
  }
  replaceMethod(JSON, "stringify");
  replaceMethod(JSON, "parse");
  replaceMethod(WeakMap.prototype, "get");
  replaceMethod(WeakMap.prototype, "has");
  replaceMethod(WeakMap.prototype, "set");
  replaceMethod(Map.prototype, "get");
  replaceMethod(String.prototype, "replace");
  replaceMethod(String, "fromCharCode");
  replaceMethod(Reflect, "apply");
  const typedArray = getPrototypeOf(Uint8Array.prototype);
  replaceGetter(typedArray, "length");
  replaceGetter(typedArray, "buffer");
  const OriginalBytes = Uint8Array;
  const OriginalDecoder = (globalThis as any).TextDecoder;
  (globalThis as any).Uint8Array = class extends OriginalBytes {
    constructor(...values: any[]) {
      super(...(values as [number]));
      seen.push(this);
    }
  };
  (globalThis as any).TextDecoder = class extends OriginalDecoder {
    decode(...values: unknown[]) {
      seen.push(values);
      return super.decode(...values);
    }
  };
  restore.push(() => {
    (globalThis as any).Uint8Array = OriginalBytes;
    (globalThis as any).TextDecoder = OriginalDecoder;
  });
  try {
    await body();
  } finally {
    for (const undo of restore.reverse()) {
      undo();
    }
  }
  return seen;
}

/** Whether `value`, or anything it holds, contains the secret. */
function holdsSecret(value: unknown, visited = new Set<unknown>()): boolean {
  if (typeof value === "string") {
    return markers.some((marker) => value.includes(marker));
  }
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return false;
  }
  visited.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return holdsSecret(Buffer.from(value as ArrayBuffer).toString("latin1"));
  }
  return Reflect.ownKeys(value).some((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && "value" in descriptor
      ? holdsSecret(descriptor.value, visited)
      : false;
  });
}

test("replaced built-in functions do not observe non-extractable key material", async () => {
  stand.call = fakeHost;
  const hmac = { name: "HMAC", hash: "SHA-256", length: 160 };
  const hkdf = await subtle.importKey("raw", new Uint8Array(16), "HKDF", false, ["deriveKey"]);
  const kw = await subtle.importKey("raw", new Uint8Array(16), "AES-KW", false, ["unwrapKey"]);
  const keys: CryptoKey[] = [];

  const seen = await spyOnBuiltIns(async () => {
    const generated = (await subtle.generateKey(hmac, false, ["sign"])) as CryptoKey;
    await subtle.sign("HMAC", generated, new Uint8Array(1));
    const derived = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
      hkdf,
      hmac,
      false,
      ["sign"],
    );
    await subtle.sign("HMAC", derived, new Uint8Array(1));
    const unwrapped = await subtle.unwrapKey("raw", new Uint8Array(24), kw, "AES-KW", hmac, false, [
      "sign",
    ]);
    const unwrappedJwk = await subtle.unwrapKey(
      "jwk",
      new Uint8Array([0, 0, 0]),
      kw,
      "AES-KW",
      hmac,
      false,
      ["sign"],
    );
    await subtle.sign("HMAC", unwrappedJwk, new Uint8Array(1));
    keys.push(generated, derived, unwrapped, unwrappedJwk);
  });

  expect(keys).toHaveLength(4);
  for (const key of keys) {
    expect(key.extractable).toBe(false);
    await expect(subtle.exportKey("raw", key)).rejects.toThrow("not extractable");
  }
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((value) => holdsSecret(value))).toStrictEqual([]);
});
