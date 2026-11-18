/** Web IDL DOMString conversion rejects symbols, unlike String(symbol). */
export function domString(value: unknown): string {
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a symbol to a DOMString");
  }
  return String(value);
}

export function byteString(value: unknown): string {
  const text = domString(value);
  if (/[\u0100-\uffff]/.test(text)) {
    throw new TypeError("Expected a ByteString");
  }
  return text;
}

export function unsignedShort(value: unknown): number {
  // Unary plus follows Web IDL ToNumber, including rejecting BigInt and Symbol.
  const number = +(value as number);
  if (!Number.isFinite(number) || number === 0) {
    return 0;
  }
  return ((Math.trunc(number) % 65536) + 65536) % 65536;
}

export function dictionary(value: unknown): any {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" && typeof value !== "function") {
    throw new TypeError("Expected a dictionary");
  }
  return value;
}

/** Convert unmatched UTF-16 surrogates to the USVString replacement character. */
export function usvString(value: unknown): string {
  return domString(value).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (part) =>
    part.length === 2 ? part : "\uFFFD",
  );
}

/** Web IDL [Clamp] long long, used by Blob.slice; ties round to the even integer. */
export function clampedLongLong(value: unknown): number {
  let number = +(value as number);
  if (Number.isNaN(number)) {
    return 0;
  }
  number = Math.max(-(2 ** 63), Math.min(2 ** 63 - 1, number));
  const lower = Math.floor(number);
  const fraction = number - lower;
  if (fraction < 0.5) {
    return lower;
  }
  if (fraction > 0.5) {
    return lower + 1;
  }
  return lower % 2 === 0 ? lower : lower + 1;
}

/** Web IDL regular attributes are enumerable, configurable prototype accessors. */
export function exposeAttributes(prototype: object, names: readonly string[]) {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.get) {
      throw new TypeError(`Missing attribute getter: ${name}`);
    }
    Object.defineProperty(prototype, name, {
      ...descriptor,
      enumerable: true,
    });
  }
}
