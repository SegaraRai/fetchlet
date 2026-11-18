// node:string_decoder: decodes a byte stream into strings without splitting
// characters across writes. UTF-8 uses the profile's streaming TextDecoder;
// UTF-16LE and base64 keep their incomplete units; the other encodings
// decode each byte on its own.

import { Buffer } from "../buffer/buffer.ts";
import { nodeError } from "../errors/errors.ts";

type NodeBuffer = InstanceType<typeof Buffer>;

const encodings: Record<string, string> = {
  utf8: "utf8",
  "utf-8": "utf8",
  ucs2: "utf16le",
  "ucs-2": "utf16le",
  utf16le: "utf16le",
  "utf-16le": "utf16le",
  latin1: "latin1",
  binary: "latin1",
  base64: "base64",
  base64url: "base64url",
  hex: "hex",
  ascii: "ascii",
};

function normalize(encoding: unknown): string {
  if (encoding === undefined || encoding === null || encoding === "") {
    return "utf8";
  }
  const name = encodings[String(encoding).toLowerCase()];
  if (!name) {
    throw nodeError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${String(encoding)}`);
  }
  return name;
}

function view(input: unknown): Uint8Array {
  if (typeof input === "string") {
    return Buffer.from(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw nodeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    'The "buf" argument must be an instance of Buffer, TypedArray, or DataView.',
  );
}

export class StringDecoder {
  readonly encoding: string;
  #utf8: TextDecoder | undefined;
  #pending: Uint8Array = new Uint8Array();

  constructor(encoding?: string) {
    this.encoding = normalize(encoding);
    if (this.encoding === "utf8") {
      this.#utf8 = new TextDecoder("utf-8");
    }
  }

  write(buf: ArrayBufferView | string): string {
    return this.#decode(view(buf), false);
  }

  end(buf?: ArrayBufferView | string): string {
    const text = buf === undefined ? "" : this.#decode(view(buf), false);
    return text + this.#decode(new Uint8Array(), true);
  }

  #decode(bytes: Uint8Array, flush: boolean): string {
    if (this.#utf8) {
      return this.#utf8.decode(bytes, {
        stream: !flush,
      });
    }
    const input = new Uint8Array(this.#pending.byteLength + bytes.byteLength);
    input.set(this.#pending);
    input.set(bytes, this.#pending.byteLength);
    let complete = input.byteLength;
    switch (this.encoding) {
      case "utf16le": {
        complete -= complete % 2;
        // A high surrogate waits for its low surrogate.
        const last = complete >= 2 ? input[complete - 2] | (input[complete - 1] << 8) : 0;
        if (!flush && last >= 0xd800 && last <= 0xdbff) {
          complete -= 2;
        }
        break;
      }

      case "base64":
      case "base64url":
        if (!flush) {
          complete -= complete % 3;
        }
        break;
    }
    this.#pending = flush ? new Uint8Array() : input.slice(complete);
    const buffer: NodeBuffer = Buffer.from(input.buffer, input.byteOffset, complete);
    return buffer.toString(this.encoding as "utf8");
  }
}
