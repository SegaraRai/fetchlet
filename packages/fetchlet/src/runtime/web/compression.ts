// CompressionStream and DecompressionStream (https://compression.spec.whatwg.org/).
// The host owns the codecs: flate2 for deflate, deflate-raw and gzip, and
// the brotli crate for brotli. Codecs belong to the current invocation.

import { runtime } from "./runtime";
import { hostProvides } from "./web-host";

if (!runtime.CompressionStream && hostProvides("compression")) {
  const formats = new Set(["deflate", "deflate-raw", "gzip", "brotli"]);

  const host = (operation: string, input: unknown) => {
    const reply = JSON.parse(runtime.__fetchletHost(operation, JSON.stringify(input)));
    if (!reply.ok) {
      if (reply.error.code === "INVALID_REQUEST") {
        throw new TypeError(reply.error.message);
      }
      const error: any = new Error(reply.error.message);
      error.name = "FetchletHostError";
      error.code = reply.error.code;
      throw error;
    }
    return reply.value;
  };

  /** A copy of a BufferSource chunk; other chunks error the stream. */
  const chunkBytes = (chunk: unknown): Uint8Array => {
    let buffer: unknown;
    let view: Uint8Array;
    if (chunk instanceof ArrayBuffer) {
      buffer = chunk;
      view = new Uint8Array(chunk);
    } else if (ArrayBuffer.isView(chunk)) {
      buffer = chunk.buffer;
      view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      throw new TypeError("The chunk is not a BufferSource");
    }
    if (typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer) {
      throw new TypeError("The chunk is backed by a SharedArrayBuffer");
    }
    return view.slice();
  };

  const transform = (format: string, decompress: boolean) => {
    let id: number | undefined;
    const open = () => (id ??= host("compression.open", [format, decompress]));
    const drain = (controller: TransformStreamDefaultController<Uint8Array>) => {
      for (;;) {
        const handle = host("compression.read", open());
        if (handle === null) {
          return;
        }
        controller.enqueue(runtime.__fetchletTakeBytes(handle));
      }
    };
    const close = () => {
      if (id !== undefined) {
        host("compression.close", id);
      }
    };
    const guarded =
      (step: (controller: TransformStreamDefaultController<Uint8Array>) => void) =>
      (controller: TransformStreamDefaultController<Uint8Array>) => {
        try {
          step(controller);
        } catch (error) {
          close();
          throw error;
        }
      };
    return new runtime.TransformStream({
      transform: (chunk: unknown, controller: TransformStreamDefaultController<Uint8Array>) =>
        guarded((controller) => {
          const bytes = chunkBytes(chunk);
          if (bytes.byteLength > 0) {
            host("compression.write", [open(), runtime.__fetchletPutBytes(bytes)]);
            drain(controller);
          }
        })(controller),
      flush: guarded((controller) => {
        host("compression.finish", open());
        drain(controller);
        close();
      }),
      cancel: close,
    });
  };

  const parseFormat = (args: unknown[], name: string): string => {
    if (args.length < 1) {
      throw new TypeError(`${name} requires a format`);
    }
    const format = String(args[0]);
    if (!formats.has(format)) {
      throw new TypeError(`Unsupported compression format: ${format}`);
    }
    return format;
  };

  const define = (name: string, decompress: boolean) => {
    class Codec {
      readonly #stream: TransformStream<Uint8Array, Uint8Array>;

      constructor(...args: unknown[]) {
        this.#stream = transform(parseFormat(args, name), decompress);
      }

      get readable() {
        return this.#stream.readable;
      }

      get writable() {
        return this.#stream.writable;
      }

      get [Symbol.toStringTag]() {
        return name;
      }
    }
    Object.defineProperty(Codec, "name", {
      value: name,
    });
    return Codec;
  };

  runtime.CompressionStream = define("CompressionStream", false);
  runtime.DecompressionStream = define("DecompressionStream", true);
}
