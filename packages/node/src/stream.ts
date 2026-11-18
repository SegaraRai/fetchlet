// node:stream: readable-stream 4, the port of Node's own streams, loaded by
// file so that a bundler and Node both use it rather than Node's module of
// the same name. Readable, Writable and Duplex gain fromWeb and toWeb,
// which adapt the profile's Web streams.

/// <reference path="./readable-stream.d.ts" />

import Stream from "readable-stream/lib/stream.js";
import promises from "readable-stream/lib/stream/promises.js";

import { invalidArgType } from "./errors.ts";

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
function readableFromWeb(
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
function readableToWeb(
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
function writableFromWeb(
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
function writableToWeb(streamWritable: NodeWritable): WritableStream {
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
function duplexFromWeb(
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

function duplexToWeb(duplex: NodeReadable & NodeWritable) {
  return {
    readable: readableToWeb(duplex),
    writable: writableToWeb(duplex),
  };
}

/** One end of a duplexPair: what it writes, the other end reads. */
class DuplexSide extends Stream.Duplex {
  #other: DuplexSide | undefined;
  #callback: (() => void) | undefined;

  constructor(options?: object) {
    super(options);
  }

  connect(other: DuplexSide) {
    this.#other = other;
  }

  _read() {
    const callback = this.#callback;
    if (callback) {
      this.#callback = undefined;
      callback();
    }
  }

  _write(chunk: Uint8Array, _encoding: string, callback: () => void) {
    if (chunk.length === 0) {
      queueMicrotask(callback);
      return;
    }
    this.#other!.push(chunk);
    this.#other!.#callback = callback;
  }

  _final(callback: () => void) {
    this.#other!.on("end", callback);
    this.#other!.push(null);
  }
}

/** Two Duplex streams, each reading what the other writes. */
export function duplexPair(options?: object): [unknown, unknown] {
  const first = new DuplexSide(options);
  const second = new DuplexSide(options);
  first.connect(second);
  second.connect(first);
  return [first, second];
}

Stream.duplexPair = duplexPair;
Stream.Readable.fromWeb = readableFromWeb;
Stream.Readable.toWeb = readableToWeb;
Stream.Writable.fromWeb = writableFromWeb;
Stream.Writable.toWeb = writableToWeb;
Stream.Duplex.fromWeb = duplexFromWeb;
Stream.Duplex.toWeb = duplexToWeb;

export const Readable = Stream.Readable;
export const Writable = Stream.Writable;
export const Duplex = Stream.Duplex;
export const Transform = Stream.Transform;
export const PassThrough = Stream.PassThrough;
export const pipeline = Stream.pipeline;
export const finished = Stream.finished;
export const compose = Stream.compose;
export const addAbortSignal = Stream.addAbortSignal;
export const destroy = Stream.destroy;
export const isDestroyed = Stream.isDestroyed;
export const isDisturbed = Stream.isDisturbed;
export const isErrored = Stream.isErrored;
export const isReadable = Stream.isReadable;
export const isWritable = Stream.isWritable;
export const getDefaultHighWaterMark = Stream.getDefaultHighWaterMark;
export const setDefaultHighWaterMark = Stream.setDefaultHighWaterMark;
export { Stream, promises };

export default Stream;
