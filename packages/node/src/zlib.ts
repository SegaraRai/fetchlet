// node:zlib over the host's compression operations (flate2 and brotli in
// fetchlet-web): the synchronous and callback functions and the stream
// classes for gzip, deflate, raw deflate and brotli. The host's codecs
// belong to the current invocation, and its decompressed byte budget
// applies. Compression levels, window sizes and strategies are accepted and
// not applied; the host uses its defaults.

import { Buffer, kMaxLength } from "./buffer.ts";
import { invalidArgType, nodeError, validateFunction } from "./errors.ts";
import { Transform } from "./stream.ts";

type NodeBuffer = InstanceType<typeof Buffer>;
type Format = "gzip" | "deflate" | "deflate-raw" | "brotli";
type Input = string | ArrayBuffer | ArrayBufferView;

interface ZlibOptions {
  maxOutputLength?: number;
  info?: boolean;
  [option: string]: unknown;
}

interface Runtime {
  __fetchletHost?: (operation: string, input: string) => string;
  __fetchletPutBytes(bytes: Uint8Array): number;
  __fetchletTakeBytes(handle: number): Uint8Array;
}

const runtime = globalThis as unknown as Runtime;

function host(operation: string, input: unknown): unknown {
  if (typeof runtime.__fetchletHost !== "function") {
    throw nodeError(
      Error,
      "ERR_METHOD_NOT_IMPLEMENTED",
      `node:zlib needs the fetchlet host for ${operation}`,
    );
  }
  const reply = JSON.parse(runtime.__fetchletHost(operation, JSON.stringify(input))) as {
    ok: boolean;
    value?: unknown;
    error?: {
      code: string;
      message: string;
    };
  };
  if (!reply.ok) {
    // Malformed input is the host's INVALID_REQUEST; budgets keep their codes.
    if (reply.error!.code === "INVALID_REQUEST") {
      const error = nodeError(Error, "Z_DATA_ERROR", reply.error!.message) as Error & {
        errno?: number;
      };
      error.errno = constants.Z_DATA_ERROR;
      throw error;
    }
    throw nodeError(Error, reply.error!.code, reply.error!.message);
  }
  return reply.value;
}

/** One codec of the host. */
class Codec {
  readonly #format: Format;
  readonly #decompress: boolean;
  #id: number | undefined;

  constructor(format: Format, decompress: boolean) {
    this.#format = format;
    this.#decompress = decompress;
  }

  #open(): number {
    this.#id ??= host("compression.open", [this.#format, this.#decompress]) as number;
    return this.#id;
  }

  write(bytes: Uint8Array): Uint8Array[] {
    if (bytes.byteLength > 0) {
      host("compression.write", [this.#open(), runtime.__fetchletPutBytes(bytes.slice())]);
    }
    return this.#drain();
  }

  finish(): Uint8Array[] {
    host("compression.finish", this.#open());
    return this.#drain();
  }

  close() {
    if (this.#id !== undefined) {
      host("compression.close", this.#id);
      this.#id = undefined;
    }
  }

  #drain(): Uint8Array[] {
    const pieces: Uint8Array[] = [];
    for (;;) {
      const handle = host("compression.read", this.#open()) as number | null;
      if (handle === null) {
        return pieces;
      }
      pieces.push(runtime.__fetchletTakeBytes(handle));
    }
  }
}

function toBytes(input: unknown): Uint8Array {
  if (typeof input === "string") {
    return Buffer.from(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw invalidArgType(
    "buffer",
    "of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer",
    input,
  );
}

/** gzip input starts with its magic bytes; anything else is zlib's deflate. */
function detect(bytes: Uint8Array): Format {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "deflate";
}

function convert(
  format: Format | "detect",
  decompress: boolean,
  input: Input,
  options: ZlibOptions = {},
): NodeBuffer {
  const bytes = toBytes(input);
  const codec = new Codec(format === "detect" ? detect(bytes) : format, decompress);
  let output: Uint8Array[];
  try {
    output = [...codec.write(bytes), ...codec.finish()];
  } finally {
    codec.close();
  }
  const length = output.reduce((total, piece) => total + piece.byteLength, 0);
  const maxOutputLength = options.maxOutputLength ?? kMaxLength;
  if (length > maxOutputLength) {
    throw nodeError(
      RangeError,
      "ERR_BUFFER_TOO_LARGE",
      `Cannot create a Buffer larger than ${maxOutputLength} bytes`,
    );
  }
  return Buffer.concat(output, length);
}

type Callback = (error: Error | null, result?: NodeBuffer) => void;

function callbackForm(format: Format | "detect", decompress: boolean) {
  return (input: Input, options: ZlibOptions | Callback, callback?: Callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    validateFunction(callback, "callback");
    let result: NodeBuffer;
    try {
      result = convert(format, decompress, input, options);
    } catch (error) {
      queueMicrotask(() => callback!(error as Error));
      return;
    }
    queueMicrotask(() => callback!(null, result));
  };
}

function syncForm(format: Format | "detect", decompress: boolean) {
  return (input: Input, options?: ZlibOptions) => convert(format, decompress, input, options);
}

export const gzipSync = syncForm("gzip", false);
export const gunzipSync = syncForm("gzip", true);
export const deflateSync = syncForm("deflate", false);
export const inflateSync = syncForm("deflate", true);
export const deflateRawSync = syncForm("deflate-raw", false);
export const inflateRawSync = syncForm("deflate-raw", true);
export const unzipSync = syncForm("detect", true);
export const brotliCompressSync = syncForm("brotli", false);
export const brotliDecompressSync = syncForm("brotli", true);

export const gzip = callbackForm("gzip", false);
export const gunzip = callbackForm("gzip", true);
export const deflate = callbackForm("deflate", false);
export const inflate = callbackForm("deflate", true);
export const deflateRaw = callbackForm("deflate-raw", false);
export const inflateRaw = callbackForm("deflate-raw", true);
export const unzip = callbackForm("detect", true);
export const brotliCompress = callbackForm("brotli", false);
export const brotliDecompress = callbackForm("brotli", true);

// Streams

class ZlibBase extends Transform {
  readonly #format: Format | "detect";
  readonly #decompress: boolean;
  #codec: Codec | undefined;
  bytesWritten = 0;

  constructor(format: Format | "detect", decompress: boolean, options?: ZlibOptions) {
    super(options);
    this.#format = format;
    this.#decompress = decompress;
  }

  #open(first: Uint8Array): Codec {
    this.#codec ??= new Codec(
      this.#format === "detect" ? detect(first) : this.#format,
      this.#decompress,
    );
    return this.#codec;
  }

  #push(pieces: Uint8Array[]) {
    for (const piece of pieces) {
      this.push(Buffer.from(piece.buffer as ArrayBuffer, piece.byteOffset, piece.byteLength));
    }
  }

  _transform(chunk: unknown, encoding: string, callback: (error?: Error | null) => void) {
    try {
      const bytes =
        typeof chunk === "string" ? Buffer.from(chunk, encoding as "utf8") : toBytes(chunk);
      this.bytesWritten += bytes.byteLength;
      this.#push(this.#open(bytes).write(bytes));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      this.#push(this.#open(new Uint8Array()).finish());
      this.#codec!.close();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    try {
      this.#codec?.close();
    } catch {
      // The invocation that owned the codec may have ended.
    }
    callback(error);
  }

  close(callback?: () => void) {
    if (callback) {
      this.once("close", callback);
    }
    this.destroy();
  }

  /** The host codecs flush when they finish; a flush request only calls back. */
  flush(kind?: number | (() => void), callback?: () => void) {
    const done = typeof kind === "function" ? kind : callback;
    if (done) {
      queueMicrotask(done);
    }
  }

  params(_level: number, _strategy: number, callback?: () => void) {
    if (callback) {
      queueMicrotask(callback);
    }
  }

  reset() {
    this.#codec?.close();
    this.#codec = undefined;
  }
}

export class Gzip extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("gzip", false, options);
  }
}

export class Gunzip extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("gzip", true, options);
  }
}

export class Deflate extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("deflate", false, options);
  }
}

export class Inflate extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("deflate", true, options);
  }
}

export class DeflateRaw extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("deflate-raw", false, options);
  }
}

export class InflateRaw extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("deflate-raw", true, options);
  }
}

export class Unzip extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("detect", true, options);
  }
}

export class BrotliCompress extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("brotli", false, options);
  }
}

export class BrotliDecompress extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super("brotli", true, options);
  }
}

export const createGzip = (options?: ZlibOptions) => new Gzip(options);
export const createGunzip = (options?: ZlibOptions) => new Gunzip(options);
export const createDeflate = (options?: ZlibOptions) => new Deflate(options);
export const createInflate = (options?: ZlibOptions) => new Inflate(options);
export const createDeflateRaw = (options?: ZlibOptions) => new DeflateRaw(options);
export const createInflateRaw = (options?: ZlibOptions) => new InflateRaw(options);
export const createUnzip = (options?: ZlibOptions) => new Unzip(options);
export const createBrotliCompress = (options?: ZlibOptions) => new BrotliCompress(options);
export const createBrotliDecompress = (options?: ZlibOptions) => new BrotliDecompress(options);

// CRC-32 (ISO 3309), as zlib computes it.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function crc32(data: string | ArrayBufferView, value = 0): number {
  const bytes = toBytes(data);
  let crc = ~value >>> 0;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  ZLIB_VERNUM: 4865,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_DEFAULT_MODE: 0,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_DEFAULT_WINDOW: 22,
  BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
  BROTLI_PARAM_SIZE_HINT: 5,
  BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_NPOSTFIX: 7,
  BROTLI_PARAM_NDIRECT: 8,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
} as const;

export default {
  constants,
  crc32,
  gzip,
  gzipSync,
  gunzip,
  gunzipSync,
  deflate,
  deflateSync,
  inflate,
  inflateSync,
  deflateRaw,
  deflateRawSync,
  inflateRaw,
  inflateRawSync,
  unzip,
  unzipSync,
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  Gzip,
  Gunzip,
  Deflate,
  Inflate,
  DeflateRaw,
  InflateRaw,
  Unzip,
  BrotliCompress,
  BrotliDecompress,
  createGzip,
  createGunzip,
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createUnzip,
  createBrotliCompress,
  createBrotliDecompress,
};
