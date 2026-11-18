// Random bytes, fills, integers and UUIDs from the profile's Web Crypto.

import { Buffer } from "../buffer/buffer.ts";
import { invalidArgType, outOfRange, validateFunction, validateInteger } from "../errors/errors.ts";
import { type NodeBuffer, toBytes } from "./common.ts";
import { webCrypto } from "./webcrypto.ts";

// getRandomValues fills at most 65,536 bytes per call.
const RANDOM_CHUNK = 65_536;

function fillRandom(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.byteLength; offset += RANDOM_CHUNK) {
    webCrypto.getRandomValues(
      bytes.subarray(offset, offset + RANDOM_CHUNK) as Uint8Array<ArrayBuffer>,
    );
  }
}

// Node's bound on the size of one randomBytes call.
const MAX_RANDOM_BYTES = 2 ** 31 - 1;

export function randomBytes(size: number): NodeBuffer;
export function randomBytes(
  size: number,
  callback: (error: Error | null, bytes: NodeBuffer) => void,
): void;
export function randomBytes(
  size: number,
  callback?: (error: Error | null, bytes: NodeBuffer) => void,
) {
  validateInteger(size, "size", 0, MAX_RANDOM_BYTES);
  if (callback !== undefined) {
    validateFunction(callback, "callback");
  }
  const bytes = Buffer.alloc(size);
  fillRandom(bytes);
  if (callback) {
    queueMicrotask(() => callback(null, bytes));
    return;
  }
  return bytes;
}

export const pseudoRandomBytes = randomBytes;

function fillRange(buffer: ArrayBufferView | ArrayBuffer, offset = 0, size?: number): Uint8Array {
  const bytes = toBytes(buffer, "buf");
  validateInteger(offset, "offset", 0, bytes.byteLength);
  const length = size ?? bytes.byteLength - offset;
  validateInteger(length, "size", 0, bytes.byteLength - offset);
  return bytes.subarray(offset, offset + length);
}

export function randomFillSync<T extends ArrayBufferView | ArrayBuffer>(
  buffer: T,
  offset?: number,
  size?: number,
): T {
  fillRandom(fillRange(buffer, offset, size));
  return buffer;
}

export function randomFill<T extends ArrayBufferView | ArrayBuffer>(
  buffer: T,
  ...rest:
    | [(error: Error | null, buffer: T) => void]
    | [number, (error: Error | null, buffer: T) => void]
    | [number, number, (error: Error | null, buffer: T) => void]
): void {
  const callback = rest.pop() as (error: Error | null, buffer: T) => void;
  validateFunction(callback, "callback");
  const [offset, size] = rest as number[];
  randomFillSync(buffer, offset, size);
  queueMicrotask(() => callback(null, buffer));
}

// randomInt draws from 48-bit values, as Node does.
const RANDOM_INT_RANGE = 2 ** 48;

export function randomInt(
  max: number,
  callback?: (error: Error | null, value: number) => void,
): number | void;
export function randomInt(
  min: number,
  max: number,
  callback?: (error: Error | null, value: number) => void,
): number | void;
export function randomInt(...args: unknown[]): number | void {
  const callback =
    typeof args[args.length - 1] === "function"
      ? (args.pop() as (error: Error | null, value: number) => void)
      : undefined;
  const [first, second] = args as [number, number | undefined];
  const min = second === undefined ? 0 : first;
  const max = second === undefined ? first : second;
  if (!Number.isSafeInteger(min)) {
    throw invalidArgType("min", "a safe integer", min);
  }
  if (!Number.isSafeInteger(max)) {
    throw invalidArgType("max", "a safe integer", max);
  }
  if (max <= min) {
    throw outOfRange("max", `greater than the value of "min" (${min})`, max);
  }
  const range = max - min;
  if (range > RANDOM_INT_RANGE) {
    throw outOfRange("max - min", `<= ${RANDOM_INT_RANGE}`, range);
  }
  // Rejection sampling keeps the result uniform.
  const limit = RANDOM_INT_RANGE - (RANDOM_INT_RANGE % range);
  const bytes = new Uint8Array(6) as Uint8Array<ArrayBuffer>;
  let value: number;
  do {
    webCrypto.getRandomValues(bytes);
    value = bytes.reduce((total, byte) => total * 256 + byte, 0);
  } while (value >= limit);
  const result = min + (value % range);
  if (callback) {
    queueMicrotask(() => callback(null, result));
    return;
  }
  return result;
}

export function randomUUID(_options?: { disableEntropyCache?: boolean }): string {
  return webCrypto.randomUUID();
}
