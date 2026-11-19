// What the parts of node:crypto share: input conversion, hash names and the
// two families of host operations, `nodeCrypto.*` for Node's hashes and
// derivations and `crypto.*` for the Web Crypto algorithms that keys,
// signatures and ciphers use.

import { hostFunctions } from "@fetchlet/web/host";

import { Buffer } from "../buffer/buffer.ts";
import { invalidArgType, nodeError } from "../errors/errors.ts";

export type BinaryLike = string | ArrayBuffer | ArrayBufferView;
export type Encoding =
  | "hex"
  | "base64"
  | "base64url"
  | "latin1"
  | "binary"
  | "utf8"
  | "utf-8"
  | "ascii"
  | "ucs2"
  | "utf16le";
export type NodeBuffer = InstanceType<typeof Buffer>;
export type BufferEncoding = Parameters<NodeBuffer["toString"]>[0];

interface HostReply {
  ok: boolean;
  value?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

function callHost(operation: string, input: object): unknown {
  const host = hostFunctions();
  if (host === null) {
    throw nodeError(
      Error,
      "ERR_METHOD_NOT_IMPLEMENTED",
      `node:crypto needs the fetchlet host for ${operation}`,
    );
  }
  const reply = JSON.parse(host.call(operation, JSON.stringify(input))) as HostReply;
  if (!reply.ok) {
    throw nodeError(Error, reply.error!.code, reply.error!.message);
  }
  return reply.value;
}

/** A `nodeCrypto.*` operation, which returns bytes. */
export function host(operation: string, input: object): NodeBuffer {
  return Buffer.from(callHost(operation, input) as string, "base64");
}

/**
 * A Web Crypto failure of a `crypto.*` operation, by its DOMException name
 * (DataError, OperationError, NotSupportedError, InvalidAccessError).
 */
export class WebCryptoFailure extends Error {
  readonly webName: string;

  constructor(webName: string, message: string) {
    super(message);
    this.webName = webName;
  }
}

/** A `crypto.*` operation, which returns its value or throws WebCryptoFailure. */
export function webCryptoHost(operation: string, input: object): unknown {
  const reply = callHost(operation, input) as {
    value?: unknown;
    error?: {
      name: string;
      message: string;
    };
  };
  if (reply.error) {
    throw new WebCryptoFailure(reply.error.name, reply.error.message);
  }
  return reply.value;
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}

export function fromBase64(value: string): NodeBuffer {
  return Buffer.from(value, "base64");
}

export function encode(bytes: NodeBuffer, encoding?: string): NodeBuffer | string {
  if (encoding === undefined || encoding === "buffer") {
    return bytes;
  }
  return bytes.toString(encoding as BufferEncoding);
}

export function isBinary(data: unknown): data is ArrayBuffer | ArrayBufferView {
  return ArrayBuffer.isView(data) || data instanceof ArrayBuffer;
}

export function toBytes(data: unknown, name: string, encoding?: string): Uint8Array {
  if (typeof data === "string") {
    return Buffer.from(data, (encoding ?? "utf8") as BufferEncoding);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw invalidArgType(
    name,
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView",
    data,
  );
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function toBuffer(bytes: Uint8Array): NodeBuffer {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

export const hashes = [
  "md5",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
];

const hashAliases: Record<string, string> = {
  "rsa-md5": "md5",
  "rsa-sha1": "sha1",
  "sha-1": "sha1",
  "rsa-sha224": "sha224",
  "sha-224": "sha224",
  "sha2-224": "sha224",
  "rsa-sha256": "sha256",
  "sha-256": "sha256",
  "sha2-256": "sha256",
  "rsa-sha384": "sha384",
  "sha-384": "sha384",
  "sha2-384": "sha384",
  "rsa-sha512": "sha512",
  "sha-512": "sha512",
  "sha2-512": "sha512",
  "sha512/224": "sha512-224",
  "sha-512/224": "sha512-224",
  "rsa-sha512/224": "sha512-224",
  "sha512/256": "sha512-256",
  "sha-512/256": "sha512-256",
  "rsa-sha512/256": "sha512-256",
};

/** Node's lowercase name of a supported hash, or undefined. */
export function hashName(algorithm: unknown): string | undefined {
  if (typeof algorithm !== "string") {
    return undefined;
  }
  const lower = algorithm.toLowerCase();
  const name = hashAliases[lower] ?? lower;
  return hashes.includes(name) ? name : undefined;
}

/** The hashes that the Web Crypto operations sign, encrypt and derive with. */
export const webHashes: Record<string, string> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

/** The output length of each hash, in bytes. */
export const hashLengths: Record<string, number> = {
  md5: 16,
  sha1: 20,
  sha224: 28,
  "sha512-224": 28,
  sha256: 32,
  "sha512-256": 32,
  sha384: 48,
  sha512: 64,
};

/** A callback form that runs `run` now and calls back on a later microtask. */
export function callLater<T extends unknown[]>(
  callback: (error: Error | null, ...results: T) => void,
  run: () => T,
) {
  let results: T;
  try {
    results = run();
  } catch (error) {
    queueMicrotask(() => callback(error as Error, ...([] as unknown as T)));
    return;
  }
  queueMicrotask(() => callback(null, ...results));
}
