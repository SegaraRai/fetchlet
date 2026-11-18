// node:crypto AES ciphers over the host's AES-CBC, AES-CTR and AES-GCM
// operations. CBC and CTR produce output from each update, as OpenSSL does:
// CBC chains the last ciphertext block as the next iv and decrypts without
// padding by appending a block that decrypts to a full padding block; CTR
// advances the counter by the blocks it used. GCM authenticates the whole
// message, so its output comes from final.

import { Buffer } from "../buffer/buffer.ts";
import { invalidArgType, invalidArgValue, nodeError } from "../errors/errors.ts";
import {
  base64,
  type BinaryLike,
  concat,
  encode,
  type Encoding,
  fromBase64,
  isBinary,
  type NodeBuffer,
  toBytes,
  WebCryptoFailure,
  webCryptoHost,
} from "./common.ts";
import { KeyObject, secretBytes } from "./keys.ts";

type Mode = "cbc" | "ctr" | "gcm";

interface CipherInfo {
  keyLength: number;
  mode: Mode;
}

const ciphers: Record<string, CipherInfo> = {};
for (const bits of [128, 192, 256]) {
  for (const mode of ["cbc", "ctr", "gcm"] as const) {
    ciphers[`aes-${bits}-${mode}`] = {
      keyLength: bits / 8,
      mode,
    };
  }
  ciphers[`aes${bits}`] = {
    keyLength: bits / 8,
    mode: "cbc",
  };
  ciphers[`id-aes${bits}-gcm`] = {
    keyLength: bits / 8,
    mode: "gcm",
  };
}

export function getCiphers(): string[] {
  return Object.keys(ciphers).sort();
}

export function getCipherInfo(
  nameOrNid: string,
  _options?: object,
):
  | {
      name: string;
      nid: number;
      blockSize?: number;
      ivLength: number;
      keyLength: number;
      mode: Mode;
    }
  | undefined {
  const name = typeof nameOrNid === "string" ? nameOrNid.toLowerCase() : undefined;
  const info = name === undefined ? undefined : ciphers[name];
  if (!info) {
    return undefined;
  }
  return {
    name: name!,
    nid: 0,
    ...(info.mode === "cbc" ? { blockSize: BLOCK } : {}),
    ivLength: info.mode === "gcm" ? 12 : BLOCK,
    keyLength: info.keyLength,
    mode: info.mode,
  };
}

const BLOCK = 16;
// The GCM tag lengths in bytes that both Node and the host accept.
const TAG_LENGTHS = [4, 8, 12, 13, 14, 15, 16];

const badDecrypt = () =>
  nodeError(Error, "ERR_OSSL_BAD_DECRYPT", "error:1C800064:Provider routines::bad decrypt");
const wrongFinalBlockLength = () =>
  nodeError(
    Error,
    "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH",
    "error:1C80006B:Provider routines::wrong final block length",
  );
const unauthenticated = () => new Error("Unsupported state or unable to authenticate data");

function cipherKey(key: unknown, encoding?: string): Uint8Array {
  if (key instanceof KeyObject) {
    if (key.type !== "secret") {
      throw nodeError(
        TypeError,
        "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
        `Invalid key object type ${key.type}, expected secret.`,
      );
    }
    return secretBytes(key);
  }
  if (typeof key !== "string" && !isBinary(key)) {
    throw invalidArgType(
      "key",
      "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey",
      key,
    );
  }
  return toBytes(key, "key", encoding).slice();
}

function add128(counter: Uint8Array, blocks: number): Uint8Array {
  let value = counter.reduce((total, byte) => (total << 8n) | BigInt(byte), 0n);
  value = (value + BigInt(blocks)) & ((1n << 128n) - 1n);
  const result = new Uint8Array(BLOCK);
  for (let index = BLOCK - 1; index >= 0; index -= 1) {
    result[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return result;
}

class CipherBase {
  readonly #decrypt: boolean;
  readonly #mode: Mode;
  readonly #key: Uint8Array;
  // CBC: the iv of the next block. CTR: the counter of the next block.
  #chain: Uint8Array;
  // CTR: how much of the current counter block's keystream is used.
  #offset = 0;
  #pending: Uint8Array = new Uint8Array();
  #autoPadding = true;
  #finished = false;
  // GCM
  readonly #iv: Uint8Array;
  #aad: Uint8Array = new Uint8Array();
  #tagLength: number;
  #tag: Uint8Array | undefined;

  constructor(
    decrypt: boolean,
    cipher: string,
    key: unknown,
    iv: unknown,
    options?: { authTagLength?: number },
  ) {
    if (typeof cipher !== "string") {
      throw invalidArgType("cipher", "of type string", cipher);
    }
    const info = ciphers[cipher.toLowerCase()];
    if (!info) {
      throw nodeError(Error, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
    }
    this.#decrypt = decrypt;
    this.#mode = info.mode;
    this.#key = cipherKey(key);
    if (iv !== null && typeof iv !== "string" && !isBinary(iv)) {
      throw invalidArgType(
        "iv",
        "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView",
        iv,
      );
    }
    const ivBytes = iv === null ? new Uint8Array() : toBytes(iv, "iv").slice();
    if (this.#key.byteLength !== info.keyLength) {
      throw nodeError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
    }
    if (info.mode === "gcm" ? ivBytes.byteLength === 0 : ivBytes.byteLength !== BLOCK) {
      throw nodeError(TypeError, "ERR_CRYPTO_INVALID_IV", "Invalid initialization vector");
    }
    this.#iv = ivBytes;
    this.#chain = ivBytes;
    const tagLength = options?.authTagLength;
    if (tagLength !== undefined && (info.mode !== "gcm" || !TAG_LENGTHS.includes(tagLength))) {
      throw invalidArgValue("options.authTagLength", tagLength);
    }
    this.#tagLength = tagLength ?? 16;
  }

  #call(operation: "crypto.encrypt" | "crypto.decrypt", algorithm: object, data: Uint8Array) {
    const name = (algorithm as { name: string }).name;
    return fromBase64(
      webCryptoHost(operation, {
        algorithm,
        keyAlgorithm: { name, length: this.#key.byteLength * 8 },
        key: {
          type: "secret",
          data: base64(this.#key),
        },
        data: base64(data),
      }) as string,
    );
  }

  #cbcEncrypt(iv: Uint8Array, data: Uint8Array): Uint8Array {
    return this.#call("crypto.encrypt", { name: "AES-CBC", iv: base64(iv) }, data);
  }

  /** Whole blocks through CBC, without padding. */
  #cbcBlocks(blocks: Uint8Array): Uint8Array {
    if (blocks.byteLength === 0) {
      return blocks;
    }
    const last = blocks.subarray(blocks.byteLength - BLOCK);
    let output: Uint8Array;
    if (this.#decrypt) {
      // A block that decrypts, after `last`, to a full block of padding.
      const padding = this.#cbcEncrypt(last, new Uint8Array(BLOCK).fill(BLOCK)).subarray(0, BLOCK);
      output = this.#call(
        "crypto.decrypt",
        { name: "AES-CBC", iv: base64(this.#chain) },
        concat([blocks, padding]),
      );
    } else {
      output = this.#cbcEncrypt(this.#chain, blocks).subarray(0, blocks.byteLength);
    }
    this.#chain = (this.#decrypt ? last : output.subarray(output.byteLength - BLOCK)).slice();
    return output;
  }

  #ctr(data: Uint8Array): Uint8Array {
    if (data.byteLength === 0) {
      return data;
    }
    const input = concat([new Uint8Array(this.#offset), data]);
    const output = this.#call(
      "crypto.encrypt",
      { name: "AES-CTR", counter: base64(this.#chain), length: 128 },
      input,
    );
    const used = this.#offset + data.byteLength;
    this.#chain = add128(this.#chain, Math.floor(used / BLOCK));
    this.#offset = used % BLOCK;
    return output.subarray(input.byteLength - data.byteLength);
  }

  update(data: BinaryLike, inputEncoding?: Encoding): NodeBuffer;
  update(data: BinaryLike, inputEncoding: Encoding | undefined, outputEncoding: Encoding): string;
  update(data: BinaryLike, inputEncoding?: Encoding, outputEncoding?: Encoding) {
    if (this.#finished) {
      throw nodeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state for operation update");
    }
    if (typeof data !== "string" && !isBinary(data)) {
      throw invalidArgType(
        "data",
        "of type string or an instance of Buffer, TypedArray, or DataView",
        data,
      );
    }
    const bytes = toBytes(data, "data", inputEncoding);
    let output: Uint8Array;
    switch (this.#mode) {
      case "ctr":
        output = this.#ctr(bytes);
        break;
      case "gcm":
        this.#pending = concat([this.#pending, bytes]);
        output = new Uint8Array();
        break;
      case "cbc": {
        const input = concat([this.#pending, bytes]);
        let keep = input.byteLength % BLOCK;
        // Decrypting with padding keeps the last block for final.
        if (this.#decrypt && this.#autoPadding && keep === 0 && input.byteLength > 0) {
          keep = BLOCK;
        }
        const blocks = input.subarray(0, input.byteLength - keep);
        this.#pending = input.slice(input.byteLength - keep);
        output = this.#cbcBlocks(blocks);
        break;
      }
    }
    return encode(Buffer.from(output), outputEncoding);
  }

  final(): NodeBuffer;
  final(outputEncoding: Encoding): string;
  final(outputEncoding?: Encoding) {
    if (this.#finished) {
      throw nodeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state for operation final");
    }
    this.#finished = true;
    let output: Uint8Array = new Uint8Array();
    if (this.#mode === "cbc") {
      output = this.#finalCbc();
    } else if (this.#mode === "gcm") {
      output = this.#finalGcm();
    }
    return encode(Buffer.from(output), outputEncoding);
  }

  #finalCbc(): Uint8Array {
    const pending = this.#pending;
    this.#pending = new Uint8Array();
    if (!this.#autoPadding) {
      if (pending.byteLength !== 0) {
        throw wrongFinalBlockLength();
      }
      return pending;
    }
    if (!this.#decrypt) {
      return this.#cbcEncrypt(this.#chain, pending);
    }
    if (pending.byteLength !== BLOCK) {
      throw wrongFinalBlockLength();
    }
    try {
      return this.#call("crypto.decrypt", { name: "AES-CBC", iv: base64(this.#chain) }, pending);
    } catch (error) {
      throw error instanceof WebCryptoFailure ? badDecrypt() : error;
    }
  }

  #finalGcm(): Uint8Array {
    const algorithm = {
      name: "AES-GCM",
      iv: base64(this.#iv),
      additionalData: base64(this.#aad),
      tagLength: (this.#tag?.byteLength ?? this.#tagLength) * 8,
    };
    if (!this.#decrypt) {
      const sealed = this.#call("crypto.encrypt", algorithm, this.#pending);
      const split = sealed.byteLength - this.#tagLength;
      this.#tag = sealed.slice(split);
      return sealed.subarray(0, split);
    }
    if (!this.#tag) {
      throw unauthenticated();
    }
    try {
      return this.#call("crypto.decrypt", algorithm, concat([this.#pending, this.#tag]));
    } catch (error) {
      throw error instanceof WebCryptoFailure ? unauthenticated() : error;
    }
  }

  setAutoPadding(autoPadding = true): this {
    this.#autoPadding = Boolean(autoPadding);
    return this;
  }

  setAAD(buffer: ArrayBufferView, _options?: { plaintextLength?: number }): this {
    if (this.#mode !== "gcm" || this.#finished) {
      throw nodeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state for operation setAAD");
    }
    this.#aad = concat([this.#aad, toBytes(buffer, "buffer")]);
    return this;
  }

  getAuthTag(): NodeBuffer {
    if (this.#decrypt || this.#mode !== "gcm" || !this.#finished || !this.#tag) {
      throw nodeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state for operation getAuthTag");
    }
    return Buffer.from(this.#tag);
  }

  setAuthTag(tag: BinaryLike, encoding?: Encoding): this {
    if (!this.#decrypt || this.#mode !== "gcm" || this.#finished || this.#tag) {
      throw nodeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state for operation setAuthTag");
    }
    const bytes = toBytes(tag, "buffer", encoding).slice();
    if (!TAG_LENGTHS.includes(bytes.byteLength)) {
      throw nodeError(
        TypeError,
        "ERR_CRYPTO_INVALID_AUTH_TAG",
        `Invalid authentication tag length: ${bytes.byteLength}`,
      );
    }
    this.#tag = bytes;
    return this;
  }
}

export class Cipheriv extends CipherBase {
  constructor(cipher: string, key: unknown, iv: unknown, options?: { authTagLength?: number }) {
    super(false, cipher, key, iv, options);
  }
}

export class Decipheriv extends CipherBase {
  constructor(cipher: string, key: unknown, iv: unknown, options?: { authTagLength?: number }) {
    super(true, cipher, key, iv, options);
  }
}

export function createCipheriv(
  algorithm: string,
  key: unknown,
  iv: unknown,
  options?: { authTagLength?: number },
): Cipheriv {
  return new Cipheriv(algorithm, key, iv, options);
}

export function createDecipheriv(
  algorithm: string,
  key: unknown,
  iv: unknown,
  options?: { authTagLength?: number },
): Decipheriv {
  return new Decipheriv(algorithm, key, iv, options);
}
