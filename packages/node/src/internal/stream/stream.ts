// readable-stream 4, the port of Node's own streams, loaded by file so that
// a bundler and Node both use it rather than Node's module of the same
// name, with the Web stream adapters and duplexPair attached.

import Stream from "readable-stream/lib/stream.js";
import promises from "readable-stream/lib/stream/promises.js";

import { duplexPair } from "./duplex-pair.ts";
import {
  duplexFromWeb,
  duplexToWeb,
  readableFromWeb,
  readableToWeb,
  writableFromWeb,
  writableToWeb,
} from "./web-adapters.ts";

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
