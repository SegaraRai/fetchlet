// PBKDF2, HKDF and scrypt over the host's nodeCrypto.* derivations; the
// callback forms call back on a later microtask.

import {
  invalidArgType,
  nodeError,
  outOfRange,
  validateFunction,
  validateInteger,
} from "../errors/errors.ts";
import {
  base64,
  type BinaryLike,
  hashLengths,
  hashName,
  host,
  type NodeBuffer,
  toBytes,
} from "./common.ts";

function deferred<T>(callback: unknown, run: () => T) {
  validateFunction(callback, "callback");
  let result: T;
  try {
    result = run();
  } catch (error) {
    // Argument errors throw synchronously; derivation failures reach the callback.
    if (
      (error as { code?: string }).code?.startsWith("ERR_INVALID_ARG") ||
      (error as { code?: string }).code === "ERR_OUT_OF_RANGE"
    ) {
      throw error;
    }
    queueMicrotask(() => (callback as (error: unknown) => void)(error));
    return;
  }
  queueMicrotask(() => (callback as (error: null, value: T) => void)(null, result));
}

function validateDigest(digest: unknown, name = "digest"): string {
  if (typeof digest !== "string") {
    throw invalidArgType(name, "of type string", digest);
  }
  const resolved = hashName(digest);
  if (!resolved) {
    throw nodeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${digest}`);
  }
  return resolved;
}

// Node's argument bounds for iterations and derived key lengths.
const MAX_KEY_LENGTH = 2 ** 31 - 1;

export function pbkdf2Sync(
  password: BinaryLike,
  salt: BinaryLike,
  iterations: number,
  keylen: number,
  digest: string,
): NodeBuffer {
  const passwordBytes = toBytes(password, "password");
  const saltBytes = toBytes(salt, "salt");
  validateInteger(iterations, "iterations", 1, MAX_KEY_LENGTH);
  validateInteger(keylen, "keylen", 0, MAX_KEY_LENGTH);
  const algorithm = validateDigest(digest);
  return host("nodeCrypto.pbkdf2", {
    algorithm,
    key: base64(passwordBytes),
    salt: base64(saltBytes),
    iterations,
    length: keylen,
  });
}

export function pbkdf2(
  password: BinaryLike,
  salt: BinaryLike,
  iterations: number,
  keylen: number,
  digest: string,
  callback: (error: Error | null, key: NodeBuffer) => void,
) {
  validateFunction(callback, "callback");
  deferred(callback, () => pbkdf2Sync(password, salt, iterations, keylen, digest));
}

export function hkdfSync(
  digest: string,
  ikm: BinaryLike,
  salt: BinaryLike,
  info: BinaryLike,
  keylen: number,
): ArrayBuffer {
  const algorithm = validateDigest(digest);
  const key = toBytes(ikm, "ikm");
  const saltBytes = toBytes(salt, "salt");
  const infoBytes = toBytes(info, "info");
  validateInteger(keylen, "length", 0, MAX_KEY_LENGTH);
  // Node rejects HKDF info longer than OpenSSL accepts.
  if (infoBytes.byteLength > 1024) {
    throw outOfRange("info", "must not contain more than 1024 bytes", infoBytes.byteLength);
  }
  if (keylen > 255 * hashLengths[algorithm]) {
    throw nodeError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
  }
  const bytes = host("nodeCrypto.hkdf", {
    algorithm,
    key: base64(key),
    salt: base64(saltBytes),
    info: base64(infoBytes),
    length: keylen,
  });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function hkdf(
  digest: string,
  ikm: BinaryLike,
  salt: BinaryLike,
  info: BinaryLike,
  keylen: number,
  callback: (error: Error | null, key: ArrayBuffer) => void,
) {
  validateFunction(callback, "callback");
  deferred(callback, () => hkdfSync(digest, ikm, salt, info, keylen));
}

interface ScryptOptions {
  N?: number;
  cost?: number;
  r?: number;
  blockSize?: number;
  p?: number;
  parallelization?: number;
  maxmem?: number;
}

// Node's default scrypt memory bound, in bytes.
const SCRYPT_DEFAULT_MAXMEM = 32 << 20;

function scryptParams(options: ScryptOptions = {}) {
  if (options === null || typeof options !== "object") {
    throw invalidArgType("options", "of type object", options);
  }
  const pick = (a: number | undefined, b: number | undefined, name: string, fallback: number) => {
    if (a !== undefined && b !== undefined) {
      throw nodeError(
        TypeError,
        "ERR_INCOMPATIBLE_OPTION_PAIR",
        `Option "${name}" cannot be used in combination with its alias`,
      );
    }
    const value = a ?? b ?? fallback;
    validateInteger(value, name, 0);
    return value;
  };
  const cost = pick(options.N, options.cost, "N", 16384);
  const blockSize = pick(options.r, options.blockSize, "r", 8);
  const parallelization = pick(options.p, options.parallelization, "p", 1);
  const maxmem = options.maxmem ?? SCRYPT_DEFAULT_MAXMEM;
  validateInteger(maxmem, "maxmem", 0);
  const invalid = (detail: string) =>
    nodeError(RangeError, "ERR_CRYPTO_INVALID_SCRYPT_PARAMS", `Invalid scrypt params: ${detail}`);
  if (cost < 2 || (cost & (cost - 1)) !== 0) {
    throw invalid("N must be > 1 and a power of 2");
  }
  if (blockSize < 1 || parallelization < 1) {
    throw invalid("r and p must be greater than 0");
  }
  // OpenSSL, which Node uses, counts the p blocks B of 128 * r bytes and
  // the table V of 128 * r * (N + 2) bytes against maxmem.
  if (128 * blockSize * (cost + parallelization + 2) > maxmem) {
    throw invalid("memory limit exceeded");
  }
  return {
    cost,
    blockSize,
    parallelization,
    maxMemory: maxmem,
  };
}

export function scryptSync(
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options?: ScryptOptions,
): NodeBuffer {
  const passwordBytes = toBytes(password, "password");
  const saltBytes = toBytes(salt, "salt");
  validateInteger(keylen, "keylen", 0, MAX_KEY_LENGTH);
  const params = scryptParams(options);
  return host("nodeCrypto.scrypt", {
    key: base64(passwordBytes),
    salt: base64(saltBytes),
    length: keylen,
    ...params,
  });
}

export function scrypt(
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  optionsOrCallback: ScryptOptions | ((error: Error | null, key: NodeBuffer) => void),
  callback?: (error: Error | null, key: NodeBuffer) => void,
) {
  const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
  const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
  validateFunction(done, "callback");
  deferred(done, () => scryptSync(password, salt, keylen, options));
}
