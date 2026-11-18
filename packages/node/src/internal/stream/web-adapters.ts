// fromWeb and toWeb for Readable, Writable and Duplex, adapting the
// profile's Web streams.

import Stream from "readable-stream/lib/stream.js";

import { invalidArgType } from "../errors/errors.ts";

type Chunk = unknown;

interface NodeReadable {
  readableObjectMode: boolean;
  destroyed: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(error?: unknown): unknown;
  push(chunk: Chunk): boolean;
}

interface NodeWritable {
  writableObjectMode: boolean;
  write(chunk: Chunk, callback?: (error?: Error | null) => void): boolean;
  end(callback?: () => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  destroy(error?: unknown): unknown;
}

interface ReadableOptions {
  encoding?: string;
  highWaterMark?: number;
  objectMode?: boolean;
  signal?: AbortSignal;
}

const toBytes = (chunk: Chunk): Chunk =>
  chunk instanceof Uint8Array
    ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    : chunk;

/** A Readable that reads a Web ReadableStream. */
export function readableFromWeb(
  readableStream: ReadableStream,
  options: ReadableOptions = {},
): NodeReadable {
  if (!(readableStream instanceof ReadableStream)) {
    throw invalidArgType("readableStream", "an instance of ReadableStream", readableStream);
  }
  const reader = readableStream.getReader();
  let reading = false;
  const readable: NodeReadable = new Stream.Readable({
    ...options,
    read() {
      if (reading) {
        return;
      }
      reading = true;
      reader.read().then(
        ({ done, value }) => {
          reading = false;
          if (done) {
            readable.push(null);
          } else {
            readable.push(value);
          }
        },
        (error: unknown) => readable.destroy(error),
      );
    },
    destroy(error: Error | null, callback: (error: Error | null) => void) {
      reader.cancel(error ?? undefined).then(
        () => callback(error),
        (cancelError: Error) => callback(error ?? cancelError),
      );
    },
  });
  return readable;
}

/** A Web ReadableStream that reads a Readable. */
export function readableToWeb(
  streamReadable: NodeReadable,
  options: { strategy?: QueuingStrategy } = {},
): ReadableStream {
  if (typeof streamReadable?.on !== "function") {
    throw invalidArgType("streamReadable", "an instance of Readable", streamReadable);
  }
  const objectMode = streamReadable.readableObjectMode;
  const strategy = options.strategy ?? (objectMode ? { highWaterMark: 16 } : { highWaterMark: 1 });
  let closed = false;
  return new ReadableStream(
    {
      start(controller) {
        streamReadable.pause();
        streamReadable.on("data", (chunk: Chunk) => {
          controller.enqueue(objectMode ? chunk : toBytes(chunk));
          if ((controller.desiredSize ?? 0) <= 0) {
            streamReadable.pause();
          }
        });
        Stream.finished(streamReadable, (error?: Error | null) => {
          if (closed) {
            return;
          }
          closed = true;
          if (error) {
            controller.error(error);
          } else {
            controller.close();
          }
        });
      },
      pull() {
        streamReadable.resume();
      },
      cancel(reason) {
        closed = true;
        streamReadable.destroy(reason);
      },
    },
    strategy,
  );
}

/** A Writable that writes to a Web WritableStream. */
export function writableFromWeb(
  writableStream: WritableStream,
  options: { decodeStrings?: boolean; highWaterMark?: number; objectMode?: boolean } = {},
): NodeWritable {
  if (!(writableStream instanceof WritableStream)) {
    throw invalidArgType("writableStream", "an instance of WritableStream", writableStream);
  }
  const writer = writableStream.getWriter();
  let closed = false;
  return new Stream.Writable({
    ...options,
    write(chunk: Chunk, _encoding: string, callback: (error?: Error | null) => void) {
      writer.write(toBytes(chunk)).then(() => callback(), callback);
    },
    final(callback: (error?: Error | null) => void) {
      closed = true;
      writer.close().then(() => callback(), callback);
    },
    destroy(error: Error | null, callback: (error: Error | null) => void) {
      if (closed) {
        callback(error);
        return;
      }
      writer.abort(error ?? undefined).then(
        () => callback(error),
        () => callback(error),
      );
    },
  });
}

/** A Web WritableStream that writes to a Writable. */
export function writableToWeb(streamWritable: NodeWritable): WritableStream {
  if (typeof streamWritable?.write !== "function") {
    throw invalidArgType("streamWritable", "an instance of Writable", streamWritable);
  }
  return new WritableStream({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const ready = streamWritable.write(chunk, (error) => error && reject(error));
        if (ready) {
          resolve();
        } else {
          streamWritable.once("drain", () => resolve());
        }
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        Stream.finished(streamWritable, (error?: Error | null) =>
          error ? reject(error) : resolve(),
        );
        streamWritable.end();
      });
    },
    abort(reason) {
      streamWritable.destroy(reason);
    },
  });
}

/** A Duplex over a pair of Web streams. */
export function duplexFromWeb(
  pair: { readable: ReadableStream; writable: WritableStream },
  options: ReadableOptions & { decodeStrings?: boolean } = {},
) {
  if (pair === null || typeof pair !== "object") {
    throw invalidArgType("pair", "of type object", pair);
  }
  const readable = readableFromWeb(pair.readable, options) as NodeReadable & {
    read(): Chunk;
    once(event: string, listener: () => void): void;
  };
  const writable = writableFromWeb(pair.writable, options) as NodeWritable & {
    on(event: string, listener: (...args: never[]) => void): void;
  };
  return Stream.Duplex.from({ readable, writable });
}

export function duplexToWeb(duplex: NodeReadable & NodeWritable) {
  return {
    readable: readableToWeb(duplex),
    writable: writableToWeb(duplex),
  };
}
