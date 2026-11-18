// CRC-32 (ISO 3309), as zlib computes it.

import { toBytes } from "./codec.ts";

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function crc32(data: string | ArrayBufferView, value = 0): number {
  const bytes = toBytes(data);
  let crc = ~value >>> 0;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}
