// The subset of ASN.1 DER that key encodings use: reading the elements of
// SubjectPublicKeyInfo, PKCS #8, PKCS #1, SEC 1 and X.509 structures, and
// writing the wrappers that convert between them.

export const tags = {
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  objectIdentifier: 0x06,
  sequence: 0x30,
} as const;

/** One element: its tag, where it begins and where its contents lie in `bytes`. */
export interface Element {
  tag: number;
  bytes: Uint8Array;
  offset: number;
  start: number;
  end: number;
}

export class DerError extends Error {}

/** The element at `offset`, which must lie within `limit`. */
export function readElement(bytes: Uint8Array, offset = 0, limit = bytes.byteLength): Element {
  if (offset + 2 > limit) {
    throw new DerError("truncated DER element");
  }
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const octets = length & 0x7f;
    if (octets === 0 || octets > 4 || start + octets > limit) {
      throw new DerError("unsupported DER length");
    }
    length = 0;
    for (let index = 0; index < octets; index += 1) {
      length = length * 256 + bytes[start + index];
    }
    start += octets;
  }
  const end = start + length;
  if (end > limit) {
    throw new DerError("truncated DER element");
  }
  return { tag, bytes, offset, start, end };
}

/** The whole input as one element, with nothing after it. */
export function parse(bytes: Uint8Array): Element {
  const element = readElement(bytes);
  if (element.end !== bytes.byteLength) {
    throw new DerError("trailing data after the DER element");
  }
  return element;
}

/** The elements inside a constructed element. */
export function children(element: Element): Element[] {
  const result: Element[] = [];
  let offset = element.start;
  while (offset < element.end) {
    const child = readElement(element.bytes, offset, element.end);
    result.push(child);
    offset = child.end;
  }
  return result;
}

export function contents(element: Element): Uint8Array {
  return element.bytes.subarray(element.start, element.end);
}

export function expect(element: Element | undefined, tag: number): Element {
  if (!element || element.tag !== tag) {
    throw new DerError("unexpected DER structure");
  }
  return element;
}

export function readOid(element: Element): string {
  const value = contents(expect(element, tags.objectIdentifier));
  const parts: number[] = [];
  let current = 0;
  for (const byte of value) {
    current = current * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(current);
      current = 0;
    }
  }
  const first = parts.shift() ?? 0;
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...parts].join(".");
}

/** The contents of a BIT STRING without unused bits. */
export function readBitString(element: Element): Uint8Array {
  const value = contents(expect(element, tags.bitString));
  if (value[0] !== 0) {
    throw new DerError("unexpected unused bits in a BIT STRING");
  }
  return value.subarray(1);
}

/** An unsigned INTEGER's magnitude, without a leading zero. */
export function readUnsigned(element: Element): Uint8Array {
  const value = contents(expect(element, tags.integer));
  let offset = 0;
  while (offset < value.byteLength - 1 && value[offset] === 0) {
    offset += 1;
  }
  return value.subarray(offset);
}

function lengthOctets(length: number): number[] {
  if (length < 0x80) {
    return [length];
  }
  const octets: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    octets.unshift(rest % 256);
  }
  return [0x80 | octets.length, ...octets];
}

export function encode(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const header = [tag, ...lengthOctets(length)];
  const result = new Uint8Array(header.length + length);
  result.set(header);
  let offset = header.length;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function sequence(...parts: Uint8Array[]): Uint8Array {
  return encode(tags.sequence, ...parts);
}

export function oid(dotted: string): Uint8Array {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const octets: number[] = [];
  for (const part of [first * 40 + second, ...rest]) {
    const group = [part & 0x7f];
    for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) {
      group.unshift((value & 0x7f) | 0x80);
    }
    octets.push(...group);
  }
  return encode(tags.objectIdentifier, new Uint8Array(octets));
}

/** A nonnegative INTEGER from its big-endian magnitude. */
export function unsigned(magnitude: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < magnitude.byteLength - 1 && magnitude[offset] === 0) {
    offset += 1;
  }
  const trimmed = magnitude.subarray(offset);
  return trimmed[0] & 0x80
    ? encode(tags.integer, new Uint8Array([0]), trimmed)
    : encode(tags.integer, trimmed);
}

export function bitString(value: Uint8Array): Uint8Array {
  return encode(tags.bitString, new Uint8Array([0]), value);
}

export function octetString(value: Uint8Array): Uint8Array {
  return encode(tags.octetString, value);
}

export const derNull = new Uint8Array([tags.null, 0]);

/** The whole encoding of an element, header included. */
export function whole(element: Element): Uint8Array {
  return element.bytes.subarray(element.offset, element.end);
}
