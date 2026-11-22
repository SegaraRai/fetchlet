import { concatBytes, decode, encode } from "../encoding/bytes";
import { runtime } from "../runtime/runtime";
import { supportsByteStreams } from "../streams/stream-state";
import { clampedLongLong, dictionary, domString } from "../webidl/idl";

class BlobImpl {
  protected data: Uint8Array;

  type: string;

  constructor(parts: any[] = [], options: any = {}) {
    options = dictionary(options);

    if (parts === null || (typeof parts !== "object" && typeof parts !== "function")) {
      throw new TypeError("Blob parts must be an iterable object");
    }
    const iterator = parts[Symbol.iterator];
    if (typeof iterator !== "function") {
      throw new TypeError("Blob parts must be iterable");
    }
    const iterable = { [Symbol.iterator]: () => iterator.call(parts) };
    this.data = concatBytes(
      Array.from(iterable, (part) => {
        if (part instanceof BlobImpl) {
          return part.data.slice();
        }
        if (typeof part === "string") {
          return encode(part);
        }
        if (part instanceof ArrayBuffer) {
          return new Uint8Array(part.slice(0));
        }
        if (ArrayBuffer.isView(part)) {
          return new Uint8Array(
            part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
          );
        }
        return encode(domString(part));
      }),
    );
    const endings = domString(options.endings === undefined ? "transparent" : options.endings);
    const type = domString(options.type === undefined ? "" : options.type);
    if (!["transparent", "native"].includes(endings)) {
      throw new TypeError("Invalid Blob endings");
    }
    this.type = /[^\x20-\x7e]/.test(type) ? "" : type.toLowerCase();
  }

  get size() {
    return this.data.length;
  }

  async arrayBuffer() {
    return this.data.slice().buffer;
  }

  async bytes() {
    return this.data.slice();
  }

  async text() {
    return decode(this.data);
  }

  slice(start?: number, end?: number, type?: string) {
    const from = start === undefined ? 0 : clampedLongLong(start);
    const to = end === undefined ? this.size : clampedLongLong(end);
    return new BlobImpl([this.data.slice(from, to)], { type });
  }

  stream() {
    const data = this.data.slice();
    return new runtime.ReadableStream({
      ...(supportsByteStreams() ? { type: "bytes" } : {}),
      start(controller: any) {
        if (data.byteLength > 0) {
          controller.enqueue(data);
        }
        controller.close();
      },
    });
  }

  /** Decode as UTF-8 regardless of the type's charset parameter. */
  textStream() {
    return this.stream().pipeThrough(new runtime.TextDecoderStream());
  }

  get [Symbol.toStringTag]() {
    return "Blob";
  }
}

class FileImpl extends BlobImpl {
  name: string;
  lastModified: number;

  constructor(parts: any[], name: string, options: any = {}) {
    if (arguments.length < 2) {
      throw new TypeError("File requires bits and a name");
    }
    options = dictionary(options);
    super(parts, options);
    this.name = String(name);
    this.lastModified = options.lastModified ?? Date.now();
  }

  get [Symbol.toStringTag]() {
    return "File";
  }
}

/** The bytes of a Blob of this profile, without copying, or undefined. */
export function blobBytes(value: unknown): Uint8Array | undefined {
  return value instanceof BlobImpl ? (value as unknown as { data: Uint8Array }).data : undefined;
}

Object.defineProperty(BlobImpl, "name", { value: "Blob" });
Object.defineProperty(FileImpl, "name", { value: "File" });

runtime.Blob ??= BlobImpl;
runtime.File ??= FileImpl;
