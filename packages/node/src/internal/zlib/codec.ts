// The host's compression codecs (flate2 and brotli in fetchlet-web) and the
// one-shot conversion over them. The codecs belong to the current
// invocation, and the host's decompressed byte budget applies. Levels,
// window sizes and strategies are accepted and not applied.

import { hostFunctions } from "@fetchlet/web/host";

import { Buffer, kMaxLength } from "../buffer/buffer.ts";
import { invalidArgType, nodeError } from "../errors/errors.ts";
import { constants } from "./constants.ts";

export type NodeBuffer = InstanceType<typeof Buffer>;
export type Format = "gzip" | "deflate" | "deflate-raw" | "brotli";
export type Input = string | ArrayBuffer | ArrayBufferView;

export interface ZlibOptions {
  maxOutputLength?: number;
  info?: boolean;
  [option: string]: unknown;
}

function host(operation: string, input: unknown): unknown {
  const functions = hostFunctions();
  if (functions === null) {
    throw nodeError(
      Error,
      "ERR_METHOD_NOT_IMPLEMENTED",
      `node:zlib needs the fetchlet host for ${operation}`,
    );
  }
  const reply = JSON.parse(functions.call(operation, JSON.stringify(input))) as {
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
export class Codec {
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
      host("compression.write", [this.#open(), hostFunctions()!.putBytes(bytes.slice())]);
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
      pieces.push(hostFunctions()!.takeBytes(handle));
    }
  }
}

export function toBytes(input: unknown): Uint8Array {
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
export function detect(bytes: Uint8Array): Format {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "deflate";
}

export function convert(
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
