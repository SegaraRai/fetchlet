import { concatBytes, decode, encode } from "./bytes";
import { multipart } from "./form-data";
import { exposeAttributes } from "./idl";
import { essence, multipartBoundary, parseMultipart } from "./multipart";
import { runtime } from "./runtime";
import { isDisturbed, supportsByteStreams } from "./stream-state";
import { teeBody } from "./tee";

import "./blob";
import "./headers";

export class BodyImpl {
  protected stream: any = null;
  protected consumed = false;
  protected contentType: string | null = null;

  #headers: any;

  /** Web IDL brand check for the Body attribute getters. */
  static #check(value: BodyImpl) {
    if (!(#headers in value)) throw new TypeError("Illegal invocation");
  }

  constructor(body: any = null, headers?: any) {
    this.#headers = new runtime.Headers(headers);
    if (body == null) {
      return;
    }
    if (body instanceof runtime.FormData) {
      body = multipart(body);
    }
    if (body instanceof runtime.ReadableStream) {
      if (body.locked || isDisturbed(body)) throw new TypeError("Body stream is unusable");
      this.stream = body;
    } else if (body instanceof runtime.Blob) {
      this.stream = body.stream();
      this.contentType = body.type;
    } else {
      let bytes: Uint8Array;
      if (body instanceof runtime.URLSearchParams) {
        bytes = encode(body.toString());
        this.contentType = "application/x-www-form-urlencoded;charset=UTF-8";
      } else if (body instanceof ArrayBuffer) {
        bytes = new Uint8Array(body.slice(0));
      } else if (ArrayBuffer.isView(body)) {
        bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
      } else {
        bytes = encode(String(body));
        this.contentType = "text/plain;charset=UTF-8";
      }
      // Fetch body streams are byte streams where the host can transfer buffers.
      this.stream = new runtime.ReadableStream({
        ...(supportsByteStreams() ? { type: "bytes" } : {}),
        start(controller: any) {
          if (bytes.byteLength > 0) controller.enqueue(bytes);
          controller.close();
        },
      });
    }
    if (this.contentType && !this.headers.has("content-type")) {
      this.headers.set("content-type", this.contentType);
    }
  }

  get headers() {
    BodyImpl.#check(this);
    return this.#headers;
  }

  get body() {
    BodyImpl.#check(this);
    return this.stream;
  }

  get bodyUsed() {
    BodyImpl.#check(this);
    return this.stream !== null && (this.consumed || isDisturbed(this.stream));
  }

  /**
   * Fetch's "fully read body", then convert the bytes.
   *
   * Reads go through pipeTo's internal read requests, and every intermediate
   * promise settles with undefined, so a patched Object.prototype.then cannot
   * observe or replace chunks. Only the final result is resolved, as in Fetch.
   */
  #consume<T>(convert: (bytes: Uint8Array) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.bodyUsed || this.stream?.locked) {
        throw new TypeError("Body already consumed or locked");
      }
      const complete = (bytes: Uint8Array) => {
        try {
          resolve(convert(bytes));
        } catch (error) {
          reject(error);
        }
      };
      if (!this.stream) {
        complete(new Uint8Array(0));
        return;
      }
      this.consumed = true;
      const chunks: Uint8Array[] = [];
      const sink = new runtime.WritableStream({
        write(chunk: unknown) {
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError("Expected byte chunk");
          }
          chunks.push(chunk);
        },
      });
      this.stream.pipeTo(sink).then(() => complete(concatBytes(chunks)), reject);
    });
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#consume((bytes) => bytes.buffer as ArrayBuffer);
  }

  bytes() {
    return this.#consume((bytes) => bytes);
  }

  text() {
    return this.#consume(decode);
  }

  json() {
    return this.#consume((bytes) => JSON.parse(decode(bytes)));
  }

  blob() {
    const type = this.headers.get("content-type") ?? "";
    return this.#consume((bytes) => new runtime.Blob([bytes], { type }));
  }

  /** Decode the body as UTF-8 text chunks; a null body yields a new empty stream each time. */
  textStream() {
    if (this.bodyUsed || this.stream?.locked) {
      throw new TypeError("Body already consumed or locked");
    }
    const decoder = new runtime.TextDecoderStream();
    if (!this.stream) {
      return new runtime.ReadableStream({
        start(controller: any) {
          controller.close();
        },
      }).pipeThrough(decoder);
    }
    this.consumed = true;
    return this.stream.pipeThrough(decoder);
  }

  formData() {
    const type = this.headers.get("content-type") ?? "";
    // Consume the body before parsing, so stream errors take precedence over type errors.
    return this.#consume((bytes) => parseForm(bytes, type));
  }

  protected cloneStream() {
    if (this.bodyUsed || this.stream?.locked) {
      throw new TypeError("Cannot clone consumed body");
    }
    if (!this.stream) {
      return null;
    }
    const [retained, cloned] = teeBody(this.stream);
    this.stream = retained;
    return cloned;
  }
}

/** Parse a fully read body as `application/x-www-form-urlencoded` or `multipart/form-data`. */
function parseForm(bytes: Uint8Array, type: string) {
  const data = new runtime.FormData();
  if (essence(type) === "application/x-www-form-urlencoded") {
    for (const [key, value] of new runtime.URLSearchParams(decode(bytes))) {
      data.append(key, value);
    }
    return data;
  }
  const boundary = multipartBoundary(type);
  if (boundary === null) {
    throw new TypeError("Unsupported form content type");
  }
  for (const entry of parseMultipart(bytes, boundary)) {
    if (entry.filename !== undefined) {
      data.append(
        entry.name,
        new runtime.File([entry.value], entry.filename, {
          type: entry.contentType ?? "text/plain",
        }),
      );
    } else {
      data.append(entry.name, decode(entry.value));
    }
  }
  return data;
}

exposeAttributes(BodyImpl.prototype, ["headers", "body", "bodyUsed"]);
