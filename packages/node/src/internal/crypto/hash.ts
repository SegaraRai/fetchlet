// Hashes and HMAC over the host's nodeCrypto.* digests, and timingSafeEqual.

import { invalidArgType, nodeError } from "../errors/errors.ts";
import {
  base64,
  type BinaryLike,
  concat,
  encode,
  type Encoding,
  hashes,
  hashName,
  host,
  type NodeBuffer,
  toBytes,
} from "./common.ts";

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
