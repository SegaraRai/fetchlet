// IncomingMessage: a Readable of a fetch response body with Node's view of
// its status and headers.

import { Buffer } from "../buffer/buffer.ts";
import { Readable } from "../stream/stream.ts";
import { STATUS_CODES } from "./constants.ts";

/** A response: a Readable of the body with Node's view of the status and headers. */
export class IncomingMessage extends Readable {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  readonly httpVersion = "1.1";
  readonly httpVersionMajor = 1;
  readonly httpVersionMinor = 1;
  complete = false;
  readonly statusCode: number | undefined;
  readonly statusMessage: string | undefined;
  readonly headers: Record<string, string | string[]> = {};
  readonly headersDistinct: Record<string, string[]> = {};
  readonly rawHeaders: string[] = [];
  readonly trailers: Record<string, string> = {};
  readonly rawTrailers: string[] = [];
  url = "";
  method: string | null = null;
  socket = null;

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
