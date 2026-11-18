// The Web Cryptography API globals (https://w3c.github.io/webcrypto/):
// crypto, Crypto, SubtleCrypto and CryptoKey, installed when the host
// implements the `crypto.*` operations.

import { runtime } from "../runtime/runtime";
import { hostProvides } from "../runtime/web-host";
import { exposeAttributes } from "../webidl/idl";
import { domException, randomBytes } from "./host";
import { CryptoKey } from "./key";
import { SubtleCrypto, createSubtle } from "./subtle";

/** The getRandomValues quota of the specification, in bytes. */
const RANDOM_QUOTA = 65_536;

const integerArrays = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
]
  .map((name) => runtime[name])
  .filter((constructor) => typeof constructor === "function");

const brand = new WeakSet<object>();
const construct = Symbol("Crypto");
const subtle = createSubtle();

function checkBrand(value: unknown) {
  if (typeof value !== "object" || value === null || !brand.has(value)) {
    throw new TypeError("Illegal invocation");
  }
}

class Crypto {
  constructor(token?: unknown) {
    if (token !== construct) {
      throw new TypeError("Illegal constructor");
    }
    brand.add(this);
  }

  get subtle(): SubtleCrypto {
    checkBrand(this);
    return subtle;
  }

  getRandomValues<T extends ArrayBufferView>(array: T): T {
    checkBrand(this);
    if (arguments.length < 1) {
      throw new TypeError("1 argument required, but only 0 present");
    }
    if (!ArrayBuffer.isView(array)) {
      throw new TypeError("Expected an ArrayBufferView");
    }
    if (!integerArrays.some((constructor) => array instanceof constructor)) {
      throw domException("TypeMismatchError", "The array is not an integer typed array");
    }
    if (array.byteLength > RANDOM_QUOTA) {
      throw new runtime.QuotaExceededError(`The array exceeds ${RANDOM_QUOTA} bytes`);
    }
    if (array.byteLength > 0) {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
        randomBytes(array.byteLength),
      );
    }
    return array;
  }

  randomUUID(): string {
    checkBrand(this);
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

exposeAttributes(Crypto.prototype, ["subtle"]);
Object.defineProperty(Crypto.prototype, Symbol.toStringTag, {
  value: "Crypto",
  configurable: true,
});

if (!runtime.crypto && hostProvides("crypto")) {
  runtime.Crypto = Crypto;
  runtime.SubtleCrypto = SubtleCrypto;
  runtime.CryptoKey = CryptoKey;
  runtime.crypto = new Crypto(construct);
}
