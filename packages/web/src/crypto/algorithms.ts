// Algorithm normalization (https://w3c.github.io/webcrypto/#algorithm-normalization-normalize-an-algorithm)
// with the registered algorithms and their parameter dictionaries, plus
// the per-algorithm key usages and JSON Web Key `alg` values.

import { domString } from "../idl";
import { domException } from "./host";

export type Operation =
  | "encrypt"
  | "decrypt"
  | "sign"
  | "verify"
  | "digest"
  | "generateKey"
  | "deriveBits"
  | "importKey"
  | "wrapKey"
  | "unwrapKey"
  | "get key length";

type Conversion = "bytes" | "bigInteger" | "hash" | "key" | "long" | "short" | "octet" | "string";

/** Members after `name`, inherited dictionaries first, each in lexicographic order. */
type Members = readonly (readonly [member: string, conversion: Conversion, required: boolean])[];

const dictionaries: Record<string, Members> = {
  AesCtrParams: [
    ["counter", "bytes", true],
    ["length", "octet", true],
  ],
  AesCbcParams: [["iv", "bytes", true]],
  AesGcmParams: [
    ["additionalData", "bytes", false],
    ["iv", "bytes", true],
    ["tagLength", "octet", false],
  ],
  AesKeyGenParams: [["length", "short", true]],
  AesDerivedKeyParams: [["length", "short", true]],
  HmacImportParams: [
    ["hash", "hash", true],
    ["length", "long", false],
  ],
  RsaHashedKeyGenParams: [
    ["modulusLength", "long", true],
    ["publicExponent", "bigInteger", true],
    ["hash", "hash", true],
  ],
  RsaHashedImportParams: [["hash", "hash", true]],
  RsaPssParams: [["saltLength", "long", true]],
  RsaOaepParams: [["label", "bytes", false]],
  EcdsaParams: [["hash", "hash", true]],
  EcKeyParams: [["namedCurve", "string", true]],
  EcdhKeyDeriveParams: [["public", "key", true]],
  HkdfParams: [
    ["hash", "hash", true],
    ["info", "bytes", true],
    ["salt", "bytes", true],
  ],
  Pbkdf2Params: [
    ["hash", "hash", true],
    ["iterations", "long", true],
    ["salt", "bytes", true],
  ],
};

/** The parameter dictionary of each registered algorithm and operation; "" is plain Algorithm. */
const registry: Partial<Record<Operation, Record<string, string>>> = {
  digest: { "SHA-1": "", "SHA-256": "", "SHA-384": "", "SHA-512": "" },
  sign: {
    "RSASSA-PKCS1-v1_5": "",
    "RSA-PSS": "RsaPssParams",
    ECDSA: "EcdsaParams",
    Ed25519: "",
    HMAC: "",
  },
  encrypt: {
    "RSA-OAEP": "RsaOaepParams",
    "AES-CTR": "AesCtrParams",
    "AES-CBC": "AesCbcParams",
    "AES-GCM": "AesGcmParams",
  },
  generateKey: {
    "RSASSA-PKCS1-v1_5": "RsaHashedKeyGenParams",
    "RSA-PSS": "RsaHashedKeyGenParams",
    "RSA-OAEP": "RsaHashedKeyGenParams",
    ECDSA: "EcKeyParams",
    ECDH: "EcKeyParams",
    Ed25519: "",
    X25519: "",
    "AES-CTR": "AesKeyGenParams",
    "AES-CBC": "AesKeyGenParams",
    "AES-GCM": "AesKeyGenParams",
    "AES-KW": "AesKeyGenParams",
    HMAC: "HmacImportParams",
  },
  importKey: {
    "RSASSA-PKCS1-v1_5": "RsaHashedImportParams",
    "RSA-PSS": "RsaHashedImportParams",
    "RSA-OAEP": "RsaHashedImportParams",
    ECDSA: "EcKeyParams",
    ECDH: "EcKeyParams",
    Ed25519: "",
    X25519: "",
    "AES-CTR": "",
    "AES-CBC": "",
    "AES-GCM": "",
    "AES-KW": "",
    HMAC: "HmacImportParams",
    HKDF: "",
    PBKDF2: "",
  },
  deriveBits: {
    ECDH: "EcdhKeyDeriveParams",
    X25519: "EcdhKeyDeriveParams",
    HKDF: "HkdfParams",
    PBKDF2: "Pbkdf2Params",
  },
  wrapKey: { "AES-KW": "" },
  "get key length": {
    "AES-CTR": "AesDerivedKeyParams",
    "AES-CBC": "AesDerivedKeyParams",
    "AES-GCM": "AesDerivedKeyParams",
    "AES-KW": "AesDerivedKeyParams",
    HMAC: "HmacImportParams",
    HKDF: "",
    PBKDF2: "",
  },
};
registry.verify = registry.sign;
registry.decrypt = registry.encrypt;
registry.unwrapKey = registry.wrapKey;

let isCryptoKey: (value: unknown) => boolean = () => false;

/** Let the key module identify CryptoKey instances for `public` members. */
export function recognizeKeys(test: (value: unknown) => boolean) {
  isCryptoKey = test;
}

/** Web IDL BufferSource conversion, which keeps the object; copy its bytes with `copyBytes`. */
export function requireBufferSource(value: unknown): ArrayBuffer | ArrayBufferView {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  // A BufferSource without [AllowShared] rejects views of shared memory.
  if (
    ArrayBuffer.isView(value) &&
    !(typeof SharedArrayBuffer === "function" && value.buffer instanceof SharedArrayBuffer)
  ) {
    return value;
  }
  throw new TypeError("Expected a BufferSource");
}

/** A copy of the bytes a BufferSource holds now; a detached buffer holds none. */
export function copyBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source.byteLength === 0) {
    return new Uint8Array(0);
  }
  return source instanceof ArrayBuffer
    ? new Uint8Array(source).slice()
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
}

export function bufferSource(value: unknown): Uint8Array {
  return copyBytes(requireBufferSource(value));
}

/** Web IDL [EnforceRange] conversion to an unsigned integer of `max`. */
export function enforceRange(value: unknown, max: number): number {
  const number = +(value as number);
  if (!Number.isFinite(number)) {
    throw new TypeError("Expected a finite number");
  }
  const integer = Math.trunc(number);
  if (integer < 0 || integer > max) {
    throw new TypeError("The number is out of range");
  }
  return integer;
}

function convert(value: unknown, conversion: Conversion): unknown {
  switch (conversion) {
    case "bytes":
      return bufferSource(value);
    case "bigInteger":
      if (!(value instanceof Uint8Array)) {
        throw new TypeError("Expected a Uint8Array");
      }
      return value.slice();
    case "hash":
      return normalizeAlgorithm(value, "digest");
    case "key":
      if (!isCryptoKey(value)) {
        throw new TypeError("Expected a CryptoKey");
      }
      return value;
    case "long":
      return enforceRange(value, 2 ** 32 - 1);
    case "short":
      return enforceRange(value, 65535);
    case "octet":
      return enforceRange(value, 255);
    case "string":
      return domString(value);
  }
}

/** A normalized algorithm: `name` in its registered case and converted members. */
export function normalizeAlgorithm(algorithm: unknown, operation: Operation): any {
  if (typeof algorithm === "string") {
    return normalizeAlgorithm({ name: algorithm }, operation);
  }
  if (algorithm === null || (typeof algorithm !== "object" && typeof algorithm !== "function")) {
    throw new TypeError("Expected an algorithm object or name");
  }
  const source = algorithm as Record<string, unknown>;
  if (source.name === undefined) {
    throw new TypeError("The algorithm has no name");
  }
  const requested = domString(source.name);
  const table = registry[operation] ?? {};
  const name = Object.keys(table).find((key) => key.toUpperCase() === requested.toUpperCase());
  if (name === undefined) {
    throw domException("NotSupportedError", `${requested} does not support ${operation}`);
  }
  const normalized: any = { name };
  for (const [member, conversion, required] of dictionaries[table[name]] ?? []) {
    const value = source[member];
    if (value === undefined) {
      if (required) {
        throw new TypeError(`The algorithm has no ${member}`);
      }
      continue;
    }
    normalized[member] = convert(value, conversion);
  }
  return normalized;
}

export const keyUsages = [
  "encrypt",
  "decrypt",
  "sign",
  "verify",
  "deriveKey",
  "deriveBits",
  "wrapKey",
  "unwrapKey",
  "encapsulateKey",
  "encapsulateBits",
  "decapsulateKey",
  "decapsulateBits",
] as const;

/** Usages each key type of an algorithm allows. */
const signing = { public: ["verify"], private: ["sign"] };
const agreement = { public: [], private: ["deriveKey", "deriveBits"] };
const ciphers = { secret: ["encrypt", "decrypt", "wrapKey", "unwrapKey"] };
export const allowedUsages: Record<string, Record<string, readonly string[]>> = {
  "RSASSA-PKCS1-v1_5": signing,
  "RSA-PSS": signing,
  ECDSA: signing,
  Ed25519: signing,
  "RSA-OAEP": { public: ["encrypt", "wrapKey"], private: ["decrypt", "unwrapKey"] },
  ECDH: agreement,
  X25519: agreement,
  "AES-CTR": ciphers,
  "AES-CBC": ciphers,
  "AES-GCM": ciphers,
  "AES-KW": { secret: ["wrapKey", "unwrapKey"] },
  HMAC: { secret: ["sign", "verify"] },
  HKDF: { secret: ["deriveKey", "deriveBits"] },
  PBKDF2: { secret: ["deriveKey", "deriveBits"] },
};

/** Throw SyntaxError when `usages` has an entry outside `allowed`. */
export function checkUsages(usages: readonly string[], allowed: readonly string[]) {
  if (usages.some((usage) => !allowed.includes(usage))) {
    throw domException("SyntaxError", "The key usages are not valid for this key");
  }
}

/** The usages without duplicates, in the order of the KeyUsage enum. */
export function normalizeUsages(usages: readonly string[]): string[] {
  return keyUsages.filter((usage) => usages.includes(usage));
}

const hashSuffix: Record<string, string> = {
  "SHA-1": "1",
  "SHA-256": "256",
  "SHA-384": "384",
  "SHA-512": "512",
};

/** The JWK `alg` an ECDSA key may declare on import; export sets none. */
export function ecdsaJwkAlgorithm(namedCurve: string): string | undefined {
  return { "P-256": "ES256", "P-384": "ES384", "P-521": "ES512" }[namedCurve];
}

/** The JWK `alg` of an exported key, or undefined for algorithms that define none. */
export function jwkAlgorithm(algorithm: any): string | undefined {
  const suffix = hashSuffix[algorithm.hash?.name];
  switch (algorithm.name) {
    case "AES-CTR":
    case "AES-CBC":
    case "AES-GCM":
    case "AES-KW":
      return `A${algorithm.length}${algorithm.name.slice(4)}`;
    case "HMAC":
      return `HS${suffix}`;
    case "RSASSA-PKCS1-v1_5":
      return `RS${suffix}`;
    case "RSA-PSS":
      return `PS${suffix}`;
    case "RSA-OAEP":
      return suffix === "1" ? "RSA-OAEP" : `RSA-OAEP-${suffix}`;
    case "Ed25519":
      return "Ed25519";
    default:
      return undefined;
  }
}

/** The `use` a JWK must declare for an algorithm. */
export function jwkUse(name: string): string {
  return ["RSA-OAEP", "ECDH", "X25519"].includes(name) || name.startsWith("AES-") ? "enc" : "sig";
}

export function jwkKeyType(name: string): string {
  if (name.startsWith("AES-") || name === "HMAC") {
    return "oct";
  }
  if (name.startsWith("RSA")) {
    return "RSA";
  }
  return name.startsWith("EC") ? "EC" : "OKP";
}

/** The hash block size, which is HMAC's default key length. */
export function blockBits(hash: string): number {
  return hash === "SHA-384" || hash === "SHA-512" ? 1024 : 512;
}
