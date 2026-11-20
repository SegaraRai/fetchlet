// The built-in functions that key material passes through, captured when
// this module loads, before application code runs. Application code that
// later replaces a global function, a prototype method or a prototype
// accessor such as JSON.stringify, WeakMap.prototype.get or the TypedArray
// length getter does not observe key material, so a key created as
// non-extractable stays out of its reach as the Web Cryptography API
// requires.
//
// Key material therefore only travels through these functions, through
// objects whose prototype is null, and through primitive string operations.

const { apply } = Reflect;
const { getOwnPropertyDescriptor, getPrototypeOf, keys, setPrototypeOf } = Object;
const { isArray } = Array;
const { floor } = Math;
const { fromCharCode } = String;
const parseJson = JSON.parse;
const stringifyJson = JSON.stringify;
const ByteArray = Uint8Array;
// Reflect.apply supplies each method's receiver.
// eslint-disable-next-line typescript/unbound-method
const weakMapGet = WeakMap.prototype.get;
// eslint-disable-next-line typescript/unbound-method
const weakMapHas = WeakMap.prototype.has;
// eslint-disable-next-line typescript/unbound-method
const weakMapSet = WeakMap.prototype.set;
// eslint-disable-next-line typescript/unbound-method
const typedArrayLength = getOwnPropertyDescriptor(
  getPrototypeOf(Uint8Array.prototype),
  "length",
)!.get!;

export { floor };

/** A WeakMap whose operations do not go through WeakMap.prototype. */
export class SlotMap<V> {
  readonly #map = new WeakMap<object, V>();

  get(key: object): V | undefined {
    return apply(weakMapGet, this.#map, [key]);
  }

  has(key: object): boolean {
    return apply(weakMapHas, this.#map, [key]);
  }

  set(key: object, value: V): void {
    apply(weakMapSet, this.#map, [key, value]);
  }
}

/** The length of a Uint8Array, without its prototype's accessor. */
export function byteLength(bytes: Uint8Array): number {
  return apply(typedArrayLength, bytes, []);
}

export function allocateBytes(length: number): Uint8Array {
  return new ByteArray(length);
}

/**
 * JSON text of a message, as JSON.stringify writes it for plain data, but
 * without looking up `toJSON` on the message's objects and their
 * prototypes. Members whose value is undefined or a function are left out.
 */
export function serialize(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    // JSON.stringify looks up toJSON only on objects and BigInts.
    return stringifyJson(value) ?? "null";
  }
  if (isArray(value)) {
    let text = "[";
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      text += index === 0 ? "" : ",";
      text += item === undefined || typeof item === "function" ? "null" : serialize(item);
    }
    return text + "]";
  }
  const names = keys(value);
  let text = "{";
  let first = true;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const item = (value as Record<string, unknown>)[name];
    if (item === undefined || typeof item === "function") {
      continue;
    }
    text += (first ? "" : ",") + stringifyJson(name) + ":" + serialize(item);
    first = false;
  }
  return text + "}";
}

function nullPrototype(_name: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && !isArray(value)) {
    setPrototypeOf(value, null);
  }
  return value;
}

/**
 * Parse JSON text into objects whose prototype is null, so that reading a
 * member a message does not have runs no inherited accessor.
 */
export function parse(text: string): any {
  return parseJson(text, nullPrototype);
}

/** UTF-8 decode (https://encoding.spec.whatwg.org/#utf-8-decode). */
export function decodeUtf8(bytes: Uint8Array): string {
  const length = byteLength(bytes);
  let index = length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let text = "";
  while (index < length) {
    const first = bytes[index++];
    if (first < 0x80) {
      text += fromCharCode(first);
      continue;
    }
    let needed;
    let code;
    let lower = 0x80;
    let upper = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      code = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      code = first & 0x0f;
      lower = first === 0xe0 ? 0xa0 : 0x80;
      upper = first === 0xed ? 0x9f : 0xbf;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      code = first & 0x07;
      lower = first === 0xf0 ? 0x90 : 0x80;
      upper = first === 0xf4 ? 0x8f : 0xbf;
    } else {
      text += "�";
      continue;
    }
    let seen = 0;
    // An unexpected byte ends the sequence and is decoded again.
    while (seen < needed && index < length && bytes[index] >= lower && bytes[index] <= upper) {
      code = (code << 6) | (bytes[index] & 0x3f);
      lower = 0x80;
      upper = 0xbf;
      index += 1;
      seen += 1;
    }
    if (seen < needed) {
      text += "�";
    } else if (code > 0xffff) {
      code -= 0x10000;
      text += fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      text += fromCharCode(code);
    }
  }
  return text;
}
