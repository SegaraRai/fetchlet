// The synchronous and callback forms of each format.

import { validateFunction } from "../errors/errors.ts";
import { convert, type Format, type Input, type NodeBuffer, type ZlibOptions } from "./codec.ts";

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
