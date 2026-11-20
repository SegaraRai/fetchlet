// SubtleCrypto (https://w3c.github.io/webcrypto/#subtlecrypto-interface).
// This module converts arguments, normalizes algorithms and checks key
// usages and JSON Web Key members; the host does format conversion and
// the cryptography.

import { encode } from "../encoding/bytes";
import { domString } from "../webidl/idl";
import {
  allowedUsages,
  blockBits,
  copyBytes,
  checkUsages,
  ecdsaJwkAlgorithm,
  enforceRange,
  jwkAlgorithm,
  jwkKeyType,
  jwkUse,
  keyUsages,
  normalizeAlgorithm,
  normalizeUsages,
  requireBufferSource,
  type Operation,
} from "./algorithms";
import { cryptoCall, domException, fromBase64, toBase64 } from "./host";
import { decodeUtf8, parse } from "./intrinsics";
import { type CryptoKey, type KeySlots, type KeyType, createKey, hostKey, keySlots } from "./key";

const formats = ["raw", "spki", "pkcs8", "jwk"];

function requireArguments(count: number, required: number) {
  if (count < required) {
    throw new TypeError(`${required} arguments required, but only ${count} present`);
  }
}

/** Web IDL AlgorithmIdentifier: an object, or else a DOMString. */
function algorithmIdentifier(value: unknown): unknown {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? value
    : domString(value);
}

function keyFormat(value: unknown): string {
  const format = domString(value);
  if (!formats.includes(format)) {
    throw new TypeError(`${format} is not a KeyFormat`);
  }
  return format;
}

function sequence(value: unknown): unknown[] {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    typeof (value as any)[Symbol.iterator] !== "function"
  ) {
    throw new TypeError("Expected a sequence");
  }
  return Array.from(value as Iterable<unknown>);
}

function usageSequence(value: unknown): string[] {
  return sequence(value).map((item) => {
    const usage = domString(item);
    if (!(keyUsages as readonly string[]).includes(usage)) {
      throw new TypeError(`${usage} is not a KeyUsage`);
    }
    return usage;
  });
}

const jwkMembers = [
  "alg",
  "crv",
  "d",
  "dp",
  "dq",
  "e",
  "ext",
  "k",
  "key_ops",
  "kty",
  "n",
  "oth",
  "p",
  "q",
  "qi",
  "use",
  "x",
  "y",
];

/**
 * Web IDL conversion to the JsonWebKey dictionary. The dictionary has a null
 * prototype, so that an unwrapped key's members never meet an inherited
 * accessor.
 */
function jsonWebKey(value: unknown): any {
  if (value !== undefined && value !== null && typeof value !== "object") {
    throw new TypeError("Expected a JsonWebKey");
  }
  const source = (value ?? {}) as Record<string, unknown>;
  const jwk: any = { __proto__: null };
  for (const member of jwkMembers) {
    const item = source[member];
    if (item === undefined) {
      continue;
    }
    if (member === "ext") {
      jwk.ext = Boolean(item);
    } else if (member === "key_ops") {
      jwk.key_ops = sequence(item).map(domString);
    } else if (member === "oth") {
      jwk.oth = sequence(item);
    } else {
      jwk[member] = domString(item);
    }
  }
  return jwk;
}

/** The key's algorithm, with the parameters the host determined. */
function keyAlgorithm(normalized: any, properties: any): any {
  const algorithm: any = { name: normalized.name };
  for (const member of ["length", "namedCurve", "modulusLength"]) {
    if (properties[member] !== undefined) {
      algorithm[member] = properties[member];
    }
  }
  if (properties.publicExponent !== undefined) {
    algorithm.publicExponent = fromBase64(properties.publicExponent);
  }
  if (normalized.hash) {
    algorithm.hash = { name: normalized.hash.name };
  }
  return algorithm;
}

/** An algorithm as the host's messages carry it. */
function wire(algorithm: any): any {
  const message: any = {};
  for (const [member, value] of Object.entries(algorithm)) {
    if (member === "public") {
      continue;
    }
    if (value instanceof Uint8Array) {
      message[member] = toBase64(value);
    } else if (member === "hash") {
      message.hash = (value as any).name;
    } else {
      message[member] = value;
    }
  }
  return message;
}

function request(normalized: any, key: KeySlots, data?: Uint8Array) {
  return {
    algorithm: wire(normalized),
    keyAlgorithm: wire(key.algorithm),
    key: hostKey(key),
    data: data && toBase64(data),
  };
}

/** The checks of every operation on a key: matching algorithm and usage. */
function checkKey(normalized: any, key: KeySlots, usage: string) {
  if (normalized.name !== key.algorithm.name) {
    throw domException("InvalidAccessError", "The algorithm does not match the key");
  }
  if (!key.usages.includes(usage)) {
    throw domException("InvalidAccessError", `The key does not allow ${usage}`);
  }
}

function rejectEmptyUsages(key: CryptoKey) {
  const slots = keySlots(key);
  if (slots.type !== "public" && slots.usages.length === 0) {
    throw domException("SyntaxError", "The key has no usages");
  }
}

/** Normalize for wrapKey or unwrapKey, or else for encrypt or decrypt. */
function normalizeWrapping(algorithm: unknown, operation: Operation, fallback: Operation) {
  try {
    return normalizeAlgorithm(algorithm, operation);
  } catch (error: any) {
    if (error?.name !== "NotSupportedError") {
      throw error;
    }
    return normalizeAlgorithm(algorithm, fallback);
  }
}

function checkJwk(normalized: any, jwk: any, usages: string[], extractable: boolean) {
  const name = normalized.name;
  const fail = (message: string) => domException("DataError", message);
  if (jwk.kty !== jwkKeyType(name)) {
    throw fail(`The JWK kty is not ${jwkKeyType(name)}`);
  }
  if (usages.length > 0 && jwk.use !== undefined && jwk.use !== jwkUse(name)) {
    throw fail(`The JWK use is not ${jwkUse(name)}`);
  }
  if (jwk.key_ops !== undefined) {
    if (new Set(jwk.key_ops).size !== jwk.key_ops.length) {
      throw fail("The JWK key_ops has duplicates");
    }
    if (usages.some((usage) => !jwk.key_ops.includes(usage))) {
      throw fail("The JWK key_ops does not include the requested usages");
    }
  }
  if (jwk.ext === false && extractable) {
    throw fail("The JWK is not extractable");
  }
  if (jwk.alg === undefined || name === "ECDH" || name === "X25519") {
    return;
  }
  let expected: string[];
  if (name.startsWith("AES-")) {
    const bits = Math.floor(((jwk.k ?? "").length * 6) / 8) * 8;
    expected = [jwkAlgorithm({ name, length: bits })!];
  } else if (name === "ECDSA") {
    expected = [ecdsaJwkAlgorithm(normalized.namedCurve)!];
  } else if (name === "Ed25519") {
    expected = ["Ed25519", "EdDSA"];
  } else {
    expected = [jwkAlgorithm(normalized)!];
  }
  if (!expected.includes(jwk.alg)) {
    throw fail(`The JWK alg ${jwk.alg} does not match ${name}`);
  }
}

/** The algorithm's import key operation; `keyData` is bytes or a converted JsonWebKey. */
function importKey(
  format: string,
  keyData: any,
  normalized: any,
  extractable: boolean,
  usages: string[],
): CryptoKey {
  const name = normalized.name;
  const allowed = allowedUsages[name];
  const derivation = name === "HKDF" || name === "PBKDF2";
  const supported = derivation
    ? ["raw"]
    : allowed.secret
      ? ["raw", "jwk"]
      : name.startsWith("RSA")
        ? ["spki", "pkcs8", "jwk"]
        : formats;
  if (allowed.secret && !derivation) {
    checkUsages(usages, allowed.secret);
  }
  if (!supported.includes(format)) {
    throw domException("NotSupportedError", `${name} keys do not import as ${format}`);
  }
  let type: KeyType = "secret";
  if (derivation) {
    checkUsages(usages, allowed.secret);
    if (extractable) {
      throw domException("SyntaxError", `${name} keys are not extractable`);
    }
  } else if (!allowed.secret) {
    type =
      format === "pkcs8" || (format === "jwk" && keyData.d !== undefined) ? "private" : "public";
    checkUsages(usages, allowed[type]);
  }
  if (format === "jwk") {
    checkJwk(normalized, keyData, usages, extractable);
  }
  const reply = cryptoCall("crypto.importKey", {
    format,
    algorithm: wire(normalized),
    ...(format === "jwk" ? { jwk: keyData } : { data: toBase64(keyData) }),
  });
  return createKey(
    reply.key.type,
    extractable,
    keyAlgorithm(normalized, reply.algorithm),
    normalizeUsages(usages),
    reply.key.data,
  );
}

function exportKey(format: string, key: KeySlots): ArrayBuffer | object {
  const name = key.algorithm.name;
  if (name === "HKDF" || name === "PBKDF2") {
    throw domException("NotSupportedError", `${name} keys do not export`);
  }
  if (!key.extractable) {
    throw domException("InvalidAccessError", "The key is not extractable");
  }
  const value = cryptoCall("crypto.exportKey", { format, ...request(key.algorithm, key) });
  if (format !== "jwk") {
    return fromBase64(value).buffer;
  }
  const jwk = { ...value };
  const alg = jwkAlgorithm(key.algorithm);
  if (alg !== undefined) {
    jwk.alg = alg;
  }
  jwk.key_ops = [...key.usages];
  jwk.ext = key.extractable;
  return jwk;
}

function deriveBits(normalized: any, key: KeySlots, length: number | null): Uint8Array {
  let peer;
  if (normalized.public !== undefined) {
    const publicKey = keySlots(normalized.public);
    if (key.type !== "private") {
      throw domException("InvalidAccessError", "The base key is not a private key");
    }
    if (publicKey.type !== "public") {
      throw domException("InvalidAccessError", "The public member is not a public key");
    }
    if (
      publicKey.algorithm.name !== key.algorithm.name ||
      publicKey.algorithm.namedCurve !== key.algorithm.namedCurve
    ) {
      throw domException("InvalidAccessError", "The public key's algorithm does not match");
    }
    peer = hostKey(publicKey);
  }
  const value = cryptoCall("crypto.deriveBits", {
    ...request(normalized, key),
    public: peer,
    length,
  });
  return fromBase64(value);
}

/** The algorithm's get key length operation, for deriveKey. */
function keyLength(normalized: any): number | null {
  if (normalized.name.startsWith("AES-")) {
    if (![128, 192, 256].includes(normalized.length)) {
      throw domException("OperationError", "AES keys are 128, 192 or 256 bits");
    }
    return normalized.length;
  }
  if (normalized.name === "HMAC") {
    if (normalized.length === undefined) {
      return blockBits(normalized.hash.name);
    }
    if (normalized.length === 0) {
      throw new TypeError("The HMAC key length is zero");
    }
    return normalized.length;
  }
  return null;
}

function bytesResult(operation: string, normalized: any, key: KeySlots, data: Uint8Array) {
  return fromBase64(cryptoCall(operation, request(normalized, key, data))).buffer;
}

const brand = new WeakSet<object>();
const construct = Symbol("SubtleCrypto");

function checkBrand(value: unknown) {
  if (typeof value !== "object" || value === null || !brand.has(value)) {
    throw new TypeError("Illegal invocation");
  }
}

export class SubtleCrypto {
  constructor(token?: unknown) {
    if (token !== construct) {
      throw new TypeError("Illegal constructor");
    }
    brand.add(this);
  }

  async encrypt(algorithm: unknown, key: unknown, data: unknown) {
    checkBrand(this);
    requireArguments(arguments.length, 3);
    algorithm = algorithmIdentifier(algorithm);
    const slots = keySlots(key);
    const source = requireBufferSource(data);
    const normalized = normalizeAlgorithm(algorithm, "encrypt");
    const bytes = copyBytes(source);
    checkKey(normalized, slots, "encrypt");
    return bytesResult("crypto.encrypt", normalized, slots, bytes);
  }

  async decrypt(algorithm: unknown, key: unknown, data: unknown) {
    checkBrand(this);
    requireArguments(arguments.length, 3);
    algorithm = algorithmIdentifier(algorithm);
    const slots = keySlots(key);
    const source = requireBufferSource(data);
    const normalized = normalizeAlgorithm(algorithm, "decrypt");
    const bytes = copyBytes(source);
    checkKey(normalized, slots, "decrypt");
    return bytesResult("crypto.decrypt", normalized, slots, bytes);
  }

  async sign(algorithm: unknown, key: unknown, data: unknown) {
    checkBrand(this);
    requireArguments(arguments.length, 3);
    algorithm = algorithmIdentifier(algorithm);
    const slots = keySlots(key);
    const source = requireBufferSource(data);
    const normalized = normalizeAlgorithm(algorithm, "sign");
    const bytes = copyBytes(source);
    checkKey(normalized, slots, "sign");
    return bytesResult("crypto.sign", normalized, slots, bytes);
  }

  async verify(algorithm: unknown, key: unknown, signature: unknown, data: unknown) {
    checkBrand(this);
    requireArguments(arguments.length, 4);
    algorithm = algorithmIdentifier(algorithm);
    const slots = keySlots(key);
    const signatureSource = requireBufferSource(signature);
    const source = requireBufferSource(data);
    const normalized = normalizeAlgorithm(algorithm, "verify");
    const signatureBytes = copyBytes(signatureSource);
    const bytes = copyBytes(source);
    checkKey(normalized, slots, "verify");
    return cryptoCall("crypto.verify", {
      ...request(normalized, slots, bytes),
      signature: toBase64(signatureBytes),
    }) as boolean;
  }

  async digest(algorithm: unknown, data: unknown) {
    checkBrand(this);
    requireArguments(arguments.length, 2);
    algorithm = algorithmIdentifier(algorithm);
    const source = requireBufferSource(data);
    const normalized = normalizeAlgorithm(algorithm, "digest");
    const bytes = copyBytes(source);
    const value = cryptoCall("crypto.digest", { algorithm: normalized, data: toBase64(bytes) });
    return fromBase64(value).buffer;
  }

  async generateKey(algorithm: unknown, extractable: unknown, keyUsages: unknown) {
    checkBrand(this);
    requireArguments(arguments.length, 3);
    algorithm = algorithmIdentifier(algorithm);
    const isExtractable = Boolean(extractable);
    const usages = usageSequence(keyUsages);
    const normalized = normalizeAlgorithm(algorithm, "generateKey");
    const allowed = allowedUsages[normalized.name];
    checkUsages(usages, allowed.secret ?? [...allowed.public, ...allowed.private]);
    const reply = cryptoCall("crypto.generateKey", { algorithm: wire(normalized) });
    const keyAlgorithmValue = keyAlgorithm(normalized, reply.algorithm);
    if (reply.key) {
      const key = createKey(
        "secret",
        isExtractable,
        keyAlgorithmValue,
        normalizeUsages(usages),
        reply.key.data,
      );
      rejectEmptyUsages(key);
      return key;
    }
    const within = (list: readonly string[]) =>
      normalizeUsages(usages.filter((usage) => list.includes(usage)));
    const publicKey = createKey(
      "public",
      true,
      keyAlgorithmValue,
      within(allowed.public),
      reply.publicKey.data,
    );
    const privateKey = createKey(
      "private",
      isExtractable,
      keyAlgorithmValue,
      within(allowed.private),
      reply.privateKey.data,
    );
    rejectEmptyUsages(privateKey);
    return { publicKey, privateKey };
  }

  async deriveKey(
    algorithm: unknown,
    baseKey: unknown,
    derivedKeyType: unknown,
    extractable: unknown,
    keyUsages: unknown,
  ) {
    checkBrand(this);
    requireArguments(arguments.length, 5);
    algorithm = algorithmIdentifier(algorithm);
    const slots = keySlots(baseKey);
    derivedKeyType = algorithmIdentifier(derivedKeyType);
    const isExtractable = Boolean(extractable);
    const usages = usageSequence(keyUsages);
    const normalized = normalizeAlgorithm(algorithm, "deriveBits");
    const importAlgorithm = normalizeAlgorithm(derivedKeyType, "importKey");
    const lengthAlgorithm = normalizeAlgorithm(derivedKeyType, "get key length");
    checkKey(normalized, slots, "deriveKey");
    const bits = deriveBits(normalized, slots, keyLength(lengthAlgorithm));
    const key = importKey("raw", bits, importAlgorithm, isExtractable, usages);
    rejectEmptyUsages(key);
    return key;
  }

  async deriveBits(algorithm: unknown, baseKey: unknown, length: unknown = null) {
    checkBrand(this);
    requireArguments(arguments.length, 2);
    algorithm = algorithmIdentifier(algorithm);
    const slots = keySlots(baseKey);
    const bitLength =
      length === null || length === undefined ? null : enforceRange(length, 2 ** 32 - 1);
    const normalized = normalizeAlgorithm(algorithm, "deriveBits");
    checkKey(normalized, slots, "deriveBits");
    return deriveBits(normalized, slots, bitLength).buffer;
  }

  async importKey(
    format: unknown,
    keyData: unknown,
    algorithm: unknown,
    extractable: unknown,
    keyUsages: unknown,
  ) {
    checkBrand(this);
    requireArguments(arguments.length, 5);
    const keyFormatValue = keyFormat(format);
    const isBufferSource = keyData instanceof ArrayBuffer || ArrayBuffer.isView(keyData);
    const source = isBufferSource ? (keyData as ArrayBuffer | ArrayBufferView) : undefined;
    const jwk = isBufferSource ? undefined : jsonWebKey(keyData);
    algorithm = algorithmIdentifier(algorithm);
    const isExtractable = Boolean(extractable);
    const usages = usageSequence(keyUsages);
    if ((keyFormatValue === "jwk") === isBufferSource) {
      throw new TypeError(
        keyFormatValue === "jwk" ? "Expected a JsonWebKey" : "Expected a BufferSource",
      );
    }
    const normalized = normalizeAlgorithm(algorithm, "importKey");
    const data = source ? copyBytes(source) : jwk;
    const key = importKey(keyFormatValue, data, normalized, isExtractable, usages);
    rejectEmptyUsages(key);
    return key;
  }

  async exportKey(format: unknown, key: unknown) {
    checkBrand(this);
    requireArguments(arguments.length, 2);
    const keyFormatValue = keyFormat(format);
    return exportKey(keyFormatValue, keySlots(key));
  }

  async wrapKey(format: unknown, key: unknown, wrappingKey: unknown, wrapAlgorithm: unknown) {
    checkBrand(this);
    requireArguments(arguments.length, 4);
    const keyFormatValue = keyFormat(format);
    const slots = keySlots(key);
    const wrapping = keySlots(wrappingKey);
    wrapAlgorithm = algorithmIdentifier(wrapAlgorithm);
    const normalized = normalizeWrapping(wrapAlgorithm, "wrapKey", "encrypt");
    checkKey(normalized, wrapping, "wrapKey");
    const exported = exportKey(keyFormatValue, slots);
    const bytes =
      keyFormatValue === "jwk"
        ? encode(JSON.stringify(exported))
        : new Uint8Array(exported as ArrayBuffer);
    return bytesResult("crypto.encrypt", normalized, wrapping, bytes);
  }

  async unwrapKey(
    format: unknown,
    wrappedKey: unknown,
    unwrappingKey: unknown,
    unwrapAlgorithm: unknown,
    unwrappedKeyAlgorithm: unknown,
    extractable: unknown,
    keyUsages: unknown,
  ) {
    checkBrand(this);
    requireArguments(arguments.length, 7);
    const keyFormatValue = keyFormat(format);
    const wrappedSource = requireBufferSource(wrappedKey);
    const unwrapping = keySlots(unwrappingKey);
    unwrapAlgorithm = algorithmIdentifier(unwrapAlgorithm);
    unwrappedKeyAlgorithm = algorithmIdentifier(unwrappedKeyAlgorithm);
    const isExtractable = Boolean(extractable);
    const usages = usageSequence(keyUsages);
    const normalized = normalizeWrapping(unwrapAlgorithm, "unwrapKey", "decrypt");
    const importAlgorithm = normalizeAlgorithm(unwrappedKeyAlgorithm, "importKey");
    const wrapped = copyBytes(wrappedSource);
    checkKey(normalized, unwrapping, "unwrapKey");
    // The unwrapped key stays away from the built-in functions application
    // code can replace, as in ./intrinsics.
    const bytes = fromBase64(
      cryptoCall("crypto.decrypt", request(normalized, unwrapping, wrapped)),
    );
    let keyData: any = bytes;
    if (keyFormatValue === "jwk") {
      let parsed: unknown;
      try {
        parsed = parse(decodeUtf8(bytes));
      } catch {
        throw domException("DataError", "The unwrapped key is not JSON");
      }
      keyData = jsonWebKey(parsed);
      if (keyData.kty === undefined) {
        throw domException("DataError", "The unwrapped JWK has no kty");
      }
    }
    const key = importKey(keyFormatValue, keyData, importAlgorithm, isExtractable, usages);
    rejectEmptyUsages(key);
    return key;
  }
}

Object.defineProperty(SubtleCrypto.prototype, Symbol.toStringTag, {
  value: "SubtleCrypto",
  configurable: true,
});

export function createSubtle(): SubtleCrypto {
  return new SubtleCrypto(construct);
}
