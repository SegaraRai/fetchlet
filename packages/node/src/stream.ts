// node:stream: readable-stream 4 with the Web stream adapters.

export { duplexPair } from "./internal/stream/duplex-pair.ts";
export {
  Stream as default,
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
