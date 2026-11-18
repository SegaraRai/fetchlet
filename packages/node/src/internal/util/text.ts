// String helpers of node:util and the profile's text codecs.

import { invalidArgType } from "../errors/errors.ts";

export function stripVTControlCharacters(text: string): string {
  if (typeof text !== "string") {
    throw invalidArgType("str", "of type string", text);
  }
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g,
    "",
  );
}

export function toUSVString(text: string): string {
  const value = String(text) as string & { toWellFormed?: () => string };
  return value.toWellFormed?.() ?? value;
}

export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
