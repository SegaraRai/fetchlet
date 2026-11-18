// node:stream: readable-stream 4 with the Web stream adapters.

import { duplexPair } from "./internal/stream/duplex-pair.ts";
import {
  addAbortSignal,
  compose,
  destroy,
  Duplex,
  finished,
  getDefaultHighWaterMark,
  isDestroyed,
  isDisturbed,
  isErrored,
  isReadable,
  isWritable,
  PassThrough,
  pipeline,
  promises,
  Readable,
  setDefaultHighWaterMark,
  Stream,
  Transform,
  Writable,
} from "./internal/stream/stream.ts";

export {
  addAbortSignal,
  compose,
  destroy,
  Duplex,
  duplexPair,
  finished,
  getDefaultHighWaterMark,
  isDestroyed,
  isDisturbed,
  isErrored,
  isReadable,
  isWritable,
  PassThrough,
  pipeline,
  promises,
  Readable,
  setDefaultHighWaterMark,
  Stream,
  Transform,
  Writable,
};

export default Stream;
