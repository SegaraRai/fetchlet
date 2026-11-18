// node:stream/web: the profile's Web stream classes, which Node also
// provides as globals.

const runtime = globalThis as unknown as Record<string, unknown>;

export const ReadableStream = runtime.ReadableStream as typeof globalThis.ReadableStream;
export const ReadableStreamDefaultReader =
  runtime.ReadableStreamDefaultReader as typeof globalThis.ReadableStreamDefaultReader;
export const ReadableStreamBYOBReader =
  runtime.ReadableStreamBYOBReader as typeof globalThis.ReadableStreamBYOBReader;
export const ReadableStreamBYOBRequest =
  runtime.ReadableStreamBYOBRequest as typeof globalThis.ReadableStreamBYOBRequest;
export const ReadableByteStreamController =
  runtime.ReadableByteStreamController as typeof globalThis.ReadableByteStreamController;
export const ReadableStreamDefaultController =
  runtime.ReadableStreamDefaultController as typeof globalThis.ReadableStreamDefaultController;
export const TransformStream = runtime.TransformStream as typeof globalThis.TransformStream;
export const TransformStreamDefaultController =
  runtime.TransformStreamDefaultController as typeof globalThis.TransformStreamDefaultController;
export const WritableStream = runtime.WritableStream as typeof globalThis.WritableStream;
export const WritableStreamDefaultWriter =
  runtime.WritableStreamDefaultWriter as typeof globalThis.WritableStreamDefaultWriter;
export const WritableStreamDefaultController =
  runtime.WritableStreamDefaultController as typeof globalThis.WritableStreamDefaultController;
export const ByteLengthQueuingStrategy =
  runtime.ByteLengthQueuingStrategy as typeof globalThis.ByteLengthQueuingStrategy;
export const CountQueuingStrategy =
  runtime.CountQueuingStrategy as typeof globalThis.CountQueuingStrategy;
export const TextEncoderStream = runtime.TextEncoderStream as typeof globalThis.TextEncoderStream;
export const TextDecoderStream = runtime.TextDecoderStream as typeof globalThis.TextDecoderStream;
export const CompressionStream = runtime.CompressionStream as typeof globalThis.CompressionStream;
export const DecompressionStream =
  runtime.DecompressionStream as typeof globalThis.DecompressionStream;
