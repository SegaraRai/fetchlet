/** A copy of the bytes a channel stream's writable takes. */
export function bufferSourceBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk.slice(0));
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    );
  }
  throw new TypeError("A channel stream writes ArrayBuffer or ArrayBufferView chunks");
}
