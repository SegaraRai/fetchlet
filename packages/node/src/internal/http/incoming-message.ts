// IncomingMessage: a Readable of a fetch response body with Node's view of
// its status and headers.

import { Buffer } from "../buffer/buffer.ts";
import { Readable } from "../stream/stream.ts";
import { STATUS_CODES } from "./constants.ts";

/** A response: a Readable of the body with Node's view of the status and headers. */
export class IncomingMessage extends Readable {
  httpVersion = "1.1";
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  complete = false;
  statusCode: number | undefined;
  statusMessage: string | undefined;
  headers: Record<string, string | string[]> = {};
  headersDistinct: Record<string, string[]> = {};
  rawHeaders: string[] = [];
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
  url = "";
  method: string | null = null;
  socket = null;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor(response?: Response) {
    super();
    if (!response) {
      return;
    }
    this.statusCode = response.status;
    this.statusMessage = response.statusText || STATUS_CODES[response.status] || "";
    const setCookies = response.headers.getSetCookie?.() ?? [];
    response.headers.forEach((value, name) => {
      if (name === "set-cookie") {
        return;
      }
      this.headers[name] = value;
      this.headersDistinct[name] = [value];
      this.rawHeaders.push(name, value);
    });
    if (setCookies.length > 0) {
      this.headers["set-cookie"] = setCookies;
      this.headersDistinct["set-cookie"] = setCookies;
      for (const cookie of setCookies) {
        this.rawHeaders.push("set-cookie", cookie);
      }
    }
    this.#reader = response.body?.getReader();
  }

  _read() {
    const reader = this.#reader;
    if (!reader) {
      this.complete = true;
      this.push(null);
      return;
    }
    reader.read().then(
      ({ done, value }) => {
        if (done) {
          this.complete = true;
          this.push(null);
        } else {
          this.push(Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
        }
      },
      (error: Error) => this.destroy(error),
    );
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (this.#reader && !this.complete) {
      this.#reader.cancel(error ?? undefined).catch(() => {});
    }
    callback(error);
  }

  setTimeout(_msecs: number, callback?: () => void): this {
    if (callback) {
      this.once("timeout", callback);
    }
    return this;
  }
}
