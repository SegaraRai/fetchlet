import { runtime } from "../runtime/runtime";
import { usvString } from "../webidl/idl";

export const encode = (text: string) => new runtime.TextEncoder().encode(usvString(text));

export const decode = (bytes: Uint8Array) => new runtime.TextDecoder().decode(bytes);

export const concatBytes = (chunks: Uint8Array[]) => {
  const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
};
