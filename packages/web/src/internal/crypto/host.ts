// Calls to the host's `crypto.*` operations (the fetchlet-web crate). Bytes
// travel as standard base64; Web Cryptography API errors come back as
// `{error: {name, message}}` and are thrown as DOMExceptions.
// Key material passes through these functions, so they use only the
// built-in functions that ./intrinsics captured.

import { hostFunctions } from "../runtime/host";
import { runtime } from "../runtime/runtime";
import { allocateBytes, byteLength, floor, parse, serialize } from "./intrinsics";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const values: Record<string, number> = { __proto__: null } as any;
for (let index = 0; index < alphabet.length; index += 1) {
  values[alphabet[index]] = index;
}

export function toBase64(bytes: Uint8Array): string {
  const length = byteLength(bytes);
  let text = "";
  for (let index = 0; index < length; index += 3) {
    const triple = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    text += alphabet[triple >> 18] + alphabet[(triple >> 12) & 63];
    text += index + 1 < length ? alphabet[(triple >> 6) & 63] : "=";
    text += index + 2 < length ? alphabet[triple & 63] : "=";
  }
  return text;
}

export function fromBase64(text: string): Uint8Array {
  let length = text.length;
  while (length > 0 && text[length - 1] === "=") {
    length -= 1;
  }
  const bytes = allocateBytes(floor((length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < length; index += 1) {
    buffer = (buffer << 6) | values[text[index]];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 255;
    }
  }
  return bytes;
}

export function domException(name: string, message: string): Error {
  return new runtime.DOMException(message, name);
}

function call(operation: string, input: unknown): any {
  const reply = parse(hostFunctions()!.call(operation, serialize(input)));
  if (!reply.ok) {
    if (reply.error.code === "INVALID_REQUEST") {
      throw new TypeError(reply.error.message);
    }
    const error: any = new Error(reply.error.message);
    error.name = "FetchletHostError";
    error.code = reply.error.code;
    throw error;
  }
  return reply.value;
}

/** `size` random bytes. */
export function randomBytes(size: number): Uint8Array {
  return fromBase64(call("crypto.random", size));
}

/** Run a `crypto.*` operation and return its value. */
export function cryptoCall(operation: string, request: object): any {
  const outcome = call(operation, request);
  if (outcome.error) {
    throw domException(outcome.error.name, outcome.error.message);
  }
  return outcome.value;
}
