// Calls to the host's `crypto.*` operations (the fetchlet-web crate). Bytes
// travel as standard base64; Web Cryptography API errors come back as
// `{error: {name, message}}` and are thrown as DOMExceptions.

import { runtime } from "../runtime/runtime";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const values = new Map(Array.from(alphabet, (character, index) => [character, index]));

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const triple = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    text += alphabet[triple >> 18] + alphabet[(triple >> 12) & 63];
    text += index + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    text += index + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return text;
}

export function fromBase64(text: string): Uint8Array {
  const trimmed = text.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((trimmed.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of trimmed) {
    buffer = (buffer << 6) | values.get(character)!;
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
  const reply = JSON.parse(runtime.__fetchletHost(operation, JSON.stringify(input)));
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
