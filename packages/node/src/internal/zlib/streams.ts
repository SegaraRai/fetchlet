// The Transform stream classes and their create* factories.

import { Buffer } from "../buffer/buffer.ts";
import { Transform } from "../stream/stream.ts";
import { Codec, detect, type Format, toBytes, type ZlibOptions } from "./codec.ts";

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
