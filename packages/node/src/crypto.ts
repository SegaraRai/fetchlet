// node:crypto: random values, hashes, HMAC, timingSafeEqual and the PBKDF2,
// HKDF and scrypt derivations here, with keys, signatures and ciphers in
// the crypto-* modules and Web Crypto under `webcrypto` and `subtle`. All
// cryptography runs synchronously in the host, through the `nodeCrypto.*`
// and `crypto.*` operations of fetchlet-web; the callback forms call back
// on a later microtask.

import { Buffer } from "./buffer.ts";
import {
  Cipheriv,
  Decipheriv,
  createCipheriv,
  createDecipheriv,
  getCipherInfo,
  getCiphers,
} from "./crypto-ciphers.ts";
import {
  type BinaryLike,
  type Encoding,
  type NodeBuffer,
  encode,
  hashLengths,
  hashName,
  hashes,
  host,
  base64,
  concat,
  toBytes,
} from "./crypto-common.ts";
import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  generateKey,
  generateKeyPair,
  generateKeyPairSync,
  generateKeySync,
  getCurves,
} from "./crypto-keys.ts";
import {
  Sign,
  Verify,
  constants,
  createSign,
  createVerify,
  diffieHellman,
  privateDecrypt,
  privateEncrypt,
  publicDecrypt,
  publicEncrypt,
  sign,
  verify,
} from "./crypto-signatures.ts";
import {
  invalidArgType,
  nodeError,
  outOfRange,
  validateFunction,
  validateInteger,
} from "./errors.ts";

const webCrypto = (globalThis as unknown as { crypto: Crypto }).crypto;

export function getHashes(): string[] {
  return [...hashes];
}

class Digest {
  readonly #operation: string;
  readonly #algorithm: string;
  readonly #key: Uint8Array | undefined;
  #chunks: Uint8Array[] = [];
  #finished = false;

  constructor(operation: string, algorithm: string, key?: Uint8Array) {
    this.#operation = operation;
    this.#algorithm = algorithm;
    this.#key = key;
  }

  update(data: BinaryLike, inputEncoding?: Encoding): this {
    if (this.#finished) {
      throw nodeError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    }
    this.#chunks.push(toBytes(data, "data", inputEncoding).slice());
    return this;
  }

  digest(): NodeBuffer;
  digest(encoding: Encoding): string;
  digest(encoding?: Encoding): NodeBuffer | string {
    if (this.#finished) {
      throw nodeError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    }
    this.#finished = true;
    const data = concat(this.#chunks);
    this.#chunks = [];
    const request: Record<string, string> = {
      algorithm: this.#algorithm,
      data: base64(data),
    };
    if (this.#key) {
      request.key = base64(this.#key);
    }
    return encode(host(this.#operation, request), encoding);
  }

  protected copyInto<T extends Digest>(target: T): T {
    if (this.#finished) {
      throw nodeError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
    }
    target.#chunks = [...this.#chunks];
    return target;
  }
}

export class Hash extends Digest {
  readonly #algorithm: string;

  constructor(algorithm: string) {
    super("nodeCrypto.hash", algorithm);
    this.#algorithm = algorithm;
  }

  copy(): Hash {
    return this.copyInto(new Hash(this.#algorithm));
  }
}

export class Hmac extends Digest {}

export function createHash(algorithm: string, _options?: object): Hash {
  if (typeof algorithm !== "string") {
    throw invalidArgType("algorithm", "of type string", algorithm);
  }
  const name = hashName(algorithm);
  if (!name) {
    throw nodeError(Error, "ERR_OSSL_EVP_UNSUPPORTED", "Digest method not supported");
  }
  return new Hash(name);
}

/** One-shot hashing, as crypto.hash(algorithm, data, outputEncoding). */
export function hash(
  algorithm: string,
  data: BinaryLike,
  outputEncoding: Encoding | "buffer" = "hex",
) {
  if (typeof data !== "string" && !ArrayBuffer.isView(data)) {
    throw invalidArgType(
      "data",
      "of type string or an instance of Buffer, TypedArray, or DataView",
      data,
    );
  }
  const digest = createHash(algorithm).update(data);
  return outputEncoding === "buffer" ? digest.digest() : digest.digest(outputEncoding);
}

export function createHmac(algorithm: string, key: BinaryLike, _options?: object): Hmac {
  if (typeof algorithm !== "string") {
    throw invalidArgType("hmac", "of type string", algorithm);
  }
  const name = hashName(algorithm);
  if (!name) {
    throw nodeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${algorithm}`);
  }
  return new Hmac("nodeCrypto.hmac", name, toBytes(key, "key").slice());
}

export function timingSafeEqual(
  a: ArrayBufferView | ArrayBuffer,
  b: ArrayBufferView | ArrayBuffer,
): boolean {
  if (!ArrayBuffer.isView(a) && !(a instanceof ArrayBuffer)) {
    throw invalidArgType("buf1", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", a);
  }
  if (!ArrayBuffer.isView(b) && !(b instanceof ArrayBuffer)) {
    throw invalidArgType("buf2", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", b);
  }
  const left = toBytes(a, "buf1");
  const right = toBytes(b, "buf2");
  if (left.byteLength !== right.byteLength) {
    throw nodeError(
      RangeError,
      "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
      "Input buffers must have the same byte length",
    );
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

// getRandomValues fills at most 65,536 bytes per call.
const RANDOM_CHUNK = 65_536;

function fillRandom(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.byteLength; offset += RANDOM_CHUNK) {
    webCrypto.getRandomValues(
      bytes.subarray(offset, offset + RANDOM_CHUNK) as Uint8Array<ArrayBuffer>,
    );
  }
}

// Node's bound on the size of one randomBytes call.
const MAX_RANDOM_BYTES = 2 ** 31 - 1;

export function randomBytes(size: number): NodeBuffer;
export function randomBytes(
  size: number,
  callback: (error: Error | null, bytes: NodeBuffer) => void,
): void;
export function randomBytes(
  size: number,
  callback?: (error: Error | null, bytes: NodeBuffer) => void,
) {
  validateInteger(size, "size", 0, MAX_RANDOM_BYTES);
  if (callback !== undefined) {
    validateFunction(callback, "callback");
  }
  const bytes = Buffer.alloc(size);
  fillRandom(bytes);
  if (callback) {
    queueMicrotask(() => callback(null, bytes));
    return;
  }
  return bytes;
}

export const pseudoRandomBytes = randomBytes;

function fillRange(buffer: ArrayBufferView | ArrayBuffer, offset = 0, size?: number): Uint8Array {
  const bytes = toBytes(buffer, "buf");
  validateInteger(offset, "offset", 0, bytes.byteLength);
  const length = size ?? bytes.byteLength - offset;
  validateInteger(length, "size", 0, bytes.byteLength - offset);
  return bytes.subarray(offset, offset + length);
}

export function randomFillSync<T extends ArrayBufferView | ArrayBuffer>(
  buffer: T,
  offset?: number,
  size?: number,
): T {
  fillRandom(fillRange(buffer, offset, size));
  return buffer;
}

export function randomFill<T extends ArrayBufferView | ArrayBuffer>(
  buffer: T,
  ...rest:
    | [(error: Error | null, buffer: T) => void]
    | [number, (error: Error | null, buffer: T) => void]
    | [number, number, (error: Error | null, buffer: T) => void]
): void {
  const callback = rest.pop() as (error: Error | null, buffer: T) => void;
  validateFunction(callback, "callback");
  const [offset, size] = rest as number[];
  randomFillSync(buffer, offset, size);
  queueMicrotask(() => callback(null, buffer));
}

// randomInt draws from 48-bit values, as Node does.
const RANDOM_INT_RANGE = 2 ** 48;

export function randomInt(
  max: number,
  callback?: (error: Error | null, value: number) => void,
): number | void;
export function randomInt(
  min: number,
  max: number,
  callback?: (error: Error | null, value: number) => void,
): number | void;
export function randomInt(...args: unknown[]): number | void {
  const callback =
    typeof args[args.length - 1] === "function"
      ? (args.pop() as (error: Error | null, value: number) => void)
      : undefined;
  const [first, second] = args as [number, number | undefined];
  const min = second === undefined ? 0 : first;
  const max = second === undefined ? first : second;
  if (!Number.isSafeInteger(min)) {
    throw invalidArgType("min", "a safe integer", min);
  }
  if (!Number.isSafeInteger(max)) {
    throw invalidArgType("max", "a safe integer", max);
  }
  if (max <= min) {
    throw outOfRange("max", `greater than the value of "min" (${min})`, max);
  }
  const range = max - min;
  if (range > RANDOM_INT_RANGE) {
    throw outOfRange("max - min", `<= ${RANDOM_INT_RANGE}`, range);
  }
  // Rejection sampling keeps the result uniform.
  const limit = RANDOM_INT_RANGE - (RANDOM_INT_RANGE % range);
  const bytes = new Uint8Array(6) as Uint8Array<ArrayBuffer>;
  let value: number;
  do {
    webCrypto.getRandomValues(bytes);
    value = bytes.reduce((total, byte) => total * 256 + byte, 0);
  } while (value >= limit);
  const result = min + (value % range);
  if (callback) {
    queueMicrotask(() => callback(null, result));
    return;
  }
  return result;
}

export function randomUUID(_options?: { disableEntropyCache?: boolean }): string {
  return webCrypto.randomUUID();
}

export function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
  return webCrypto.getRandomValues(array as unknown as Uint8Array<ArrayBuffer>) as unknown as T;
}

export const webcrypto = webCrypto;
export const subtle = webCrypto.subtle;

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
  if (128 * cost * blockSize > maxmem) {
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

export {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  generateKey,
  generateKeyPair,
  generateKeyPairSync,
  generateKeySync,
  getCurves,
  Sign,
  Verify,
  constants,
  createSign,
  createVerify,
  diffieHellman,
  privateDecrypt,
  privateEncrypt,
  publicDecrypt,
  publicEncrypt,
  sign,
  verify,
  Cipheriv,
  Decipheriv,
  createCipheriv,
  createDecipheriv,
  getCipherInfo,
  getCiphers,
};

export default {
  createHash,
  createHmac,
  hash,
  getHashes,
  Hash,
  Hmac,
  timingSafeEqual,
  randomBytes,
  pseudoRandomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  getRandomValues,
  webcrypto,
  subtle,
  pbkdf2,
  pbkdf2Sync,
  hkdf,
  hkdfSync,
  scrypt,
  scryptSync,
  constants,
  KeyObject,
  createSecretKey,
  createPublicKey,
  createPrivateKey,
  generateKey,
  generateKeySync,
  generateKeyPair,
  generateKeyPairSync,
  getCurves,
  Sign,
  Verify,
  createSign,
  createVerify,
  sign,
  verify,
  publicEncrypt,
  privateDecrypt,
  privateEncrypt,
  publicDecrypt,
  diffieHellman,
  Cipheriv,
  Decipheriv,
  createCipheriv,
  createDecipheriv,
  getCipherInfo,
  getCiphers,
};
