import { concatBytes, decode, encode } from "./bytes";
import { multipart } from "./form-data";
import { runtime } from "./runtime";
import { isDisturbed, supportsByteStreams } from "./stream-state";
import { teeBody } from "./tee";

import "./blob";
import "./headers";

export class BodyImpl {
  protected stream: any = null;
  protected consumed = false;
  protected contentType: string | null = null;

  headers: any;

  constructor(body: any = null, headers?: any) {
    this.headers = new runtime.Headers(headers);
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

  get body() {
    return this.stream;
  }

  get bodyUsed() {
    return this.stream !== null && (this.consumed || isDisturbed(this.stream));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.bodyUsed || this.stream?.locked) {
      throw new TypeError("Body already consumed or locked");
    }
    if (!this.stream) {
      return new ArrayBuffer(0);
    }
    this.consumed = true;
    const reader = this.stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (!(value instanceof Uint8Array)) {
          throw new TypeError("Expected byte chunk");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return concatBytes(chunks).buffer as ArrayBuffer;
  }

  async bytes() {
    return new Uint8Array(await this.arrayBuffer());
  }

  async text() {
    return decode(await this.bytes());
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async blob() {
    return new runtime.Blob([await this.arrayBuffer()], {
      type: this.headers.get("content-type") ?? "",
    });
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

  async formData() {
    const type = this.headers.get("content-type") ?? "";
    // Consume the body before parsing, so stream errors take precedence over type errors.
    const bytes = await this.bytes();
    const data = new runtime.FormData();
    if (type.startsWith("application/x-www-form-urlencoded")) {
      for (const [key, value] of new runtime.URLSearchParams(decode(bytes))) {
        data.append(key, value);
      }
      return data;
    }
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
    if (!type.startsWith("multipart/form-data") || !match) {
      throw new TypeError("Unsupported form content type");
    }
    let raw = "";
    for (const byte of bytes) {
      raw += String.fromCharCode(byte);
    }
    const boundary = "--" + (match[1] ?? match[2]);
    if (!raw.startsWith(boundary + "--") && !raw.includes("\r\n" + boundary + "--")) {
      throw new TypeError("Multipart body has no closing boundary");
    }
    for (const part of raw.split(boundary).slice(1, -1)) {
      const split = part.indexOf("\r\n\r\n");
      if (split < 0) {
        throw new TypeError("Invalid multipart");
      }
      const header = part.slice(0, split);
      const content = part.slice(split + 4, -2);
      const name = /\bname="([^"]*)"/.exec(header)?.[1];
      if (name === undefined) {
        continue;
      }
      const chunk = Uint8Array.from(content, (character: string) => character.charCodeAt(0));
      const filename = /\bfilename="([^"]*)"/.exec(header)?.[1];
      if (filename !== undefined) {
        data.append(
          name,
          new runtime.File([chunk], filename, {
            type: /Content-Type: ([^\r\n]+)/i.exec(header)?.[1] ?? "application/octet-stream",
          }),
        );
      } else {
        data.append(name, decode(chunk));
      }
    }
    return data;
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
