// node:buffer for the vinext server: Buffer from the `buffer` package, which
// implements it on Uint8Array, and isUtf8 on a strict TextDecoder.

import bufferModule from "buffer";

export const Buffer = bufferModule.Buffer;

export function isUtf8(input: ArrayBufferView | ArrayBuffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input);
    return true;
  } catch {
    return false;
  }
}

export default {
  Buffer,
  isUtf8,
};
