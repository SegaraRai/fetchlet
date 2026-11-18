// node:stream, node:stream/web and node:string_decoder against Node's own.

import * as nodeStream from "node:stream";
import * as nodeStringDecoder from "node:string_decoder";

import stream, {
  Duplex,
  PassThrough,
  Readable,
  Transform,
  Writable,
  finished,
  pipeline,
} from "@fetchlet/node/stream";
import streamPromises from "@fetchlet/node/stream/promises";
import streamWeb from "@fetchlet/node/stream/web";
import { StringDecoder } from "@fetchlet/node/string-decoder";
import { describe, expect, test } from "vite-plus/test";

async function collect(readable: AsyncIterable<unknown>): Promise<string> {
  let text = "";
  for await (const chunk of readable) {
    text += String(chunk);
  }
  return text;
}

describe("stream", () => {
  test("the module is the legacy Stream with the classes on it", () => {
    expect(typeof stream).toBe("function");
    expect(stream.Readable).toBe(Readable);
    expect(stream.Stream).toBe(stream);
    expect(new Readable()).toBeInstanceOf(stream);
    const missing = Object.keys(nodeStream).filter((name) => !(name in stream));
    // Node's internal helper and the module's own default export.
    expect(missing).toStrictEqual(["_isArrayBufferView", "default"]);
  });

  test("pipeline runs a transform and reports completion", async () => {
    const upper = new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, String(chunk).toUpperCase());
      },
    });
    const output: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output.push(String(chunk));
        callback();
      },
    });
    await new Promise<void>((resolve, reject) =>
      pipeline(Readable.from(["fetch", "let"]), upper, sink, (error: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    expect(output.join("")).toBe("FETCHLET");
    const passThrough = new PassThrough();
    passThrough.end("done");
    await streamPromises.finished(passThrough.resume());
    expect(passThrough.readableEnded).toBe(true);
  });

  test("errors propagate through pipeline and finished", async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error("boom"));
      },
    });
    await expect(streamPromises.pipeline(failing, new PassThrough())).rejects.toThrow("boom");
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("write failed"));
      },
    });
    const done = new Promise((resolve) => finished(writable, resolve));
    writable.write("x");
    writable.on("error", () => {});
    expect(String(await done)).toContain("write failed");
  });

  test("Readable.fromWeb and toWeb adapt Web streams", async () => {
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("from "));
        controller.enqueue(new TextEncoder().encode("web"));
        controller.close();
      },
    });
    expect(await collect(Readable.fromWeb(web))).toBe("from web");
    const back = Readable.toWeb(Readable.from([Buffer.from("to "), Buffer.from("web")]));
    expect(await new Response(back).text()).toBe("to web");
    const objects = Readable.toWeb(Readable.from([{ a: 1 }, { b: 2 }]));
    const values: unknown[] = [];
    for await (const value of objects as unknown as AsyncIterable<unknown>) {
      values.push(value);
    }
    expect(values).toStrictEqual([{ a: 1 }, { b: 2 }]);
  });

  test("Writable.fromWeb, toWeb and Duplex.fromWeb", async () => {
    const received: string[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        received.push(new TextDecoder().decode(chunk));
      },
    });
    const writable = Writable.fromWeb(sink);
    writable.write("a");
    await new Promise((resolve) => writable.end("b", resolve));
    expect(received).toStrictEqual(["a", "b"]);

    const chunks: string[] = [];
    const web = Writable.toWeb(
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(String(chunk));
          callback();
        },
      }),
    );
    const writer = web.getWriter();
    await writer.write(new TextEncoder().encode("x"));
    await writer.close();
    expect(chunks).toStrictEqual(["x"]);

    const { readable, writable: input } = new TransformStream<Uint8Array, Uint8Array>();
    const duplex = Duplex.fromWeb({ readable, writable: input });
    duplex.end("through");
    expect(await collect(duplex)).toBe("through");

    const [left, right] = stream.duplexPair();
    left.end("ping");
    expect(await collect(right)).toBe("ping");
  });

  test("stream/web exports the profile's classes", () => {
    expect(streamWeb.ReadableStream).toBe(globalThis.ReadableStream);
    expect(streamWeb.TextDecoderStream).toBe(globalThis.TextDecoderStream);
  });
});

describe("string_decoder", () => {
  const cases: [string, number[][]][] = [
    ["utf8", [[0xe2, 0x82], [0xac, 0x41], [0xf0, 0x9f], [0x98]]],
    ["utf8", [[0xe2, 0x82, 0x41, 0xff]]],
    ["utf16le", [[0x61], [0x00, 0x3d, 0xd8], [0x00, 0xde]]],
    ["utf16le", [[0x3d, 0xd8]]],
    ["base64", [[1, 2], [3, 4], [5]]],
    ["base64url", [[0xfb, 0xff], [0xfe]]],
    ["hex", [[0xab], [0xcd]]],
    ["latin1", [[0xe9, 0x41]]],
    ["ascii", [[0xe9, 0x41]]],
  ];

  test.each(cases)("%s decodes across writes as Node does", (encoding, writes) => {
    const ours = new StringDecoder(encoding);
    const theirs = new nodeStringDecoder.StringDecoder(encoding as BufferEncoding);
    for (const bytes of writes) {
      expect(ours.write(new Uint8Array(bytes))).toBe(theirs.write(Buffer.from(bytes)));
    }
    expect(ours.end()).toBe(theirs.end());
  });

  test("normalizes encoding names and rejects unknown ones", () => {
    for (const name of ["UTF-8", "ucs2", "binary", "utf-16le", "latin1"]) {
      expect(new StringDecoder(name).encoding).toBe(
        new nodeStringDecoder.StringDecoder(name as BufferEncoding).encoding,
      );
    }
    expect(() => new StringDecoder("nope")).toThrow(
      expect.objectContaining({ code: "ERR_UNKNOWN_ENCODING", name: "TypeError" }),
    );
    const message = (create: (encoding: never) => unknown, encoding: unknown) => {
      try {
        create(encoding as never);
      } catch (error) {
        return (error as Error).message;
      }
    };
    for (const encoding of [1, true, [], { toString: () => "utf8" }]) {
      expect(message((value) => new StringDecoder(value), encoding)).toBe(
        message((value) => new nodeStringDecoder.StringDecoder(value), encoding),
      );
    }
  });
});
