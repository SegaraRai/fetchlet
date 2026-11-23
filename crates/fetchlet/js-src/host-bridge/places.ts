// Resources placed into JSON values by path: the byte arrays and channel
// objects Rust places at JSON Pointer reference tokens it checked name a
// value, and the byte arrays JavaScript sends beside the JSON it encodes.

import { putBytes } from "./host.ts";
import type { ByteLayout } from "./wire.ts";

/** Put `item` at `path` in `root`, returning the new root. */
export function placeAt(root: unknown, path: string[], item: unknown): unknown {
  const key = path[path.length - 1];
  if (key === undefined) {
    return item;
  }
  let parent = root as Record<string, unknown>;
  for (const token of path.slice(0, -1)) {
    parent = parent[token] as Record<string, unknown>;
  }
  // A data property, even for a key such as "__proto__".
  Object.defineProperty(parent, key, {
    value: item,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return root;
}

/** The channel object of a channel Rust lent, built by the Web API profile. */
export function lentChannel(channel: number): unknown {
  const views = globalThis.__fetchletChannelViews;
  if (!views?.lend) {
    throw new TypeError("Channels need the fetchlet Web API profile");
  }
  return views.lend(channel);
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/** JSON text, and the byte arrays left out of it, by path. */
export interface EncodedValue {
  json: string | undefined;
  parts: { path: string[]; bytes: Uint8Array }[];
}

/**
 * `value` as JSON.stringify encodes it, except that each ArrayBuffer or view
 * becomes null and is listed with its path instead. With `whole`, `value`
 * itself may be one.
 */
export function encodeWithBytes(value: unknown, whole: boolean): EncodedValue {
  const parts: EncodedValue["parts"] = [];
  // The path of each object whose properties the replacer visits.
  const paths = new WeakMap<object, string[]>();
  const json = JSON.stringify(value, function (this: unknown, key: string, item: unknown) {
    const holder = this as Record<string, unknown>;
    const parent = paths.get(holder);
    // The root's holder is a wrapper the replacer never saw as a value.
    const path = parent === undefined ? [] : [...parent, key];
    // The value before toJSON, which Node's Buffer defines.
    const raw = holder[key];
    if ((whole || path.length > 0) && isBinary(raw)) {
      const bytes = ArrayBuffer.isView(raw)
        ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : new Uint8Array(raw);
      parts.push({
        path,
        bytes,
      });
      return null;
    }
    if (typeof item === "object" && item !== null) {
      paths.set(item, path);
    }
    return item;
  });
  return {
    json,
    parts,
  };
}

/**
 * Store the byte arrays of `parts` as one buffer and return its layout, or
 * null for none. Call it right before the message that carries the layout:
 * the byte store keeps one buffer from JavaScript at a time.
 */
export function storeParts(parts: EncodedValue["parts"]): ByteLayout | null {
  if (parts.length === 0) {
    return null;
  }
  const buffer = new Uint8Array(parts.reduce((total, part) => total + part.bytes.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    buffer.set(part.bytes, offset);
    offset += part.bytes.byteLength;
  }
  const layout = parts.map((part) => ({
    path: part.path,
    length: part.bytes.byteLength,
  }));
  return {
    handle: putBytes(buffer),
    parts: layout,
  };
}
