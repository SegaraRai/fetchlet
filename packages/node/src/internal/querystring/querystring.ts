// node:querystring: Node's parse and stringify of URL query strings, with
// its escaping rules and its lenient decoding of malformed percent escapes.

import { Buffer } from "../buffer/buffer.ts";
import { nodeError } from "../errors/errors.ts";

type ParsedQuery = Record<string, string | string[]>;

interface ParseOptions {
  maxKeys?: number;
  decodeURIComponent?: (text: string) => string;
}

interface StringifyOptions {
  encodeURIComponent?: (text: string) => string;
}

const hexValue = (code: number) => {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
};

/** Decodes percent escapes into bytes, keeping malformed escapes as they are. */
export function unescapeBuffer(text: string, decodeSpaces = false) {
  const input = Buffer.from(text);
  const output = Buffer.alloc(input.length);
  let length = 0;
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (byte === 0x2b && decodeSpaces) {
      output[length++] = 0x20;
      continue;
    }
    if (byte === 0x25 && index + 2 < input.length) {
      const high = hexValue(input[index + 1]);
      const low = hexValue(input[index + 2]);
      if (high >= 0 && low >= 0) {
        output[length++] = high * 16 + low;
        index += 2;
        continue;
      }
    }
    output[length++] = byte;
  }
  return output.subarray(0, length);
}

export function unescape(text: string, decodeSpaces?: boolean): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return unescapeBuffer(text, decodeSpaces).toString();
  }
}

export function escape(text: unknown): string {
  const value = typeof text === "string" ? text : `${text as string}`;
  try {
    return encodeURIComponent(value);
  } catch {
    throw nodeError(URIError, "ERR_INVALID_URI", "URI malformed");
  }
}

function stringifyPrimitive(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? `${value}` : "";
    case "bigint":
      return `${value}`;
    case "boolean":
      return value ? "true" : "false";
    default:
      return "";
  }
}

export function stringify(
  object: unknown,
  separator = "&",
  equals = "=",
  options?: StringifyOptions,
): string {
  const encode = options?.encodeURIComponent ?? escape;
  if (object === null || typeof object !== "object") {
    return "";
  }
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(object)) {
    const prefix = encode(stringifyPrimitive(key)) + equals;
    if (Array.isArray(value)) {
      for (const item of value) {
        pairs.push(prefix + encode(stringifyPrimitive(item)));
      }
    } else {
      pairs.push(prefix + encode(stringifyPrimitive(value)));
    }
  }
  return pairs.join(separator);
}

function decodeComponent(text: string, decode: (text: string) => string): string {
  const spaced = text.replaceAll("+", " ");
  try {
    return decode(spaced);
  } catch {
    return unescape(spaced, true);
  }
}

export function parse(
  query: unknown,
  separator = "&",
  equals = "=",
  options?: ParseOptions,
): ParsedQuery {
  const result = Object.create(null) as ParsedQuery;
  if (typeof query !== "string" || query.length === 0) {
    return result;
  }
  const sep = separator || "&";
  const eq = equals || "=";
  const maxKeys = options?.maxKeys ?? 1000;
  const decode = options?.decodeURIComponent ?? unescape;
  let pairs = query.split(sep);
  if (maxKeys > 0) {
    pairs = pairs.slice(0, maxKeys);
  }
  for (const pair of pairs) {
    if (pair.length === 0) {
      continue;
    }
    const at = pair.indexOf(eq);
    const rawKey = at === -1 ? pair : pair.slice(0, at);
    const rawValue = at === -1 ? "" : pair.slice(at + eq.length);
    const key = decodeComponent(rawKey, decode);
    const value = decodeComponent(rawValue, decode);
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
}

export const decode = parse;
export const encode = stringify;
