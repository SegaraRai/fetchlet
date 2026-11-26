// Writes asset entries as one archive that Rust serves directly.
// The format is described in https://fetchlet.roundtrip.dev/docs/reference/asset-archive.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";

const MAGIC = "FLPK";
const VERSION = 1;
const HEADER_SIZE = 80;
const ENTRY_SIZE = 64;
const SET_SIZE = 8;
const PAIR_SIZE = 16;
const FLAG_BROTLI = 1;
const FLAG_KEEP_QUERY = 2;

/** Headers the server derives from the stored representation. */
const RESERVED_HEADERS = new Set([
  "accept-ranges",
  "content-encoding",
  "content-length",
  "content-range",
  "etag",
  "transfer-encoding",
]);

/** A stored body: text as UTF-8, bytes, or a file read when the archive is written. */
export type AssetBody = string | Uint8Array | { file: string };

/** One archive entry: the response stored for one URL path. */
export interface AssetEntry {
  /** The URL path, starting with `/`, matched exactly. */
  path: string;
  /** Defaults to 200. */
  status?: number;
  /** Stored as given; the archive adds no `Content-Type`. */
  headers?: HeadersInit;
  /** Defaults to an empty body. */
  body?: AssetBody;
  /** Append the request's query to the stored `Location`, for redirects. */
  appendQuery?: boolean;
}

export interface WriteAssetArchiveOptions {
  /** The entries, in any order; each path appears once. */
  entries: Iterable<AssetEntry>;
  /** The archive file to write. */
  out: string;
}

export interface AssetArchiveSummary {
  entries: number;
  rawBytes: number;
  storedBytes: number;
}

interface Stored {
  path: string;
  status: number;
  headerSet: number;
  /** A redirect that appends the request's query to its Location. */
  keepQuery: boolean;
  data: {
    offset: number;
    stored: Buffer;
    rawSize: number;
    brotli: boolean;
    hash: Buffer;
  };
}

/** Write `entries` as an asset archive at `out`. */
export async function writeAssetArchive({
  entries,
  out,
}: WriteAssetArchiveOptions): Promise<AssetArchiveSummary> {
  const sets = new HeaderSets();
  const data = new DataSection();
  const stored = new Map<string, Stored>();
  for (const entry of entries) {
    if (!entry.path.startsWith("/")) {
      throw new Error(`asset archive: ${JSON.stringify(entry.path)} does not start with /`);
    }
    if (stored.has(entry.path)) {
      throw new Error(`asset archive: ${entry.path} is served twice`);
    }
    const body = data.add(readBody(entry.body));
    stored.set(entry.path, {
      path: entry.path,
      status: entry.status ?? 200,
      headerSet: sets.add(entry.path, new Headers(entry.headers), body.brotli),
      keepQuery: entry.appendQuery ?? false,
      data: body,
    });
  }
  const sorted = [...stored.values()].sort((a, b) => Buffer.compare(utf8(a.path), utf8(b.path)));
  writeFileSync(out, encode(sorted, sets, data));
  return {
    entries: sorted.length,
    rawBytes: data.rawBytes,
    storedBytes: data.storedBytes,
  };
}

function readBody(body: AssetBody | undefined): Buffer {
  if (body === undefined) {
    return Buffer.alloc(0);
  }
  if (typeof body === "string") {
    return utf8(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return readFileSync(body.file);
}

const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");

/** Stored bodies, compressed when Brotli shrinks them, each stored once. */
class DataSection {
  #byHash = new Map<string, Stored["data"]>();

  chunks: Buffer[] = [];
  size = 0;
  rawBytes = 0;
  storedBytes = 0;

  add(raw: Buffer): Stored["data"] {
    const hash = createHash("sha256").update(raw).digest().subarray(0, 16);
    const key = hash.toString("hex");
    const existing = this.#byHash.get(key);
    if (existing) {
      return existing;
    }
    const compressed = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    const brotli = compressed.length < raw.length;
    const stored = brotli ? compressed : raw;
    const entry = {
      offset: this.size,
      stored,
      rawSize: raw.length,
      brotli,
      hash,
    };
    this.#byHash.set(key, entry);
    this.chunks.push(stored);
    this.size += stored.length;
    const padding = pad(this.size);
    if (padding) {
      this.chunks.push(Buffer.alloc(padding));
      this.size += padding;
    }
    this.rawBytes += raw.length;
    this.storedBytes += stored.length;
    return entry;
  }
}

/** Response header sets, each stored once, with their strings. */
class HeaderSets {
  #byKey = new Map<string, number>();

  sets: [string, string][][] = [];

  add(path: string, headers: Headers, brotli: boolean): number {
    const pairs: [string, string][] = [];
    for (const [name, value] of headers) {
      if (RESERVED_HEADERS.has(name)) {
        throw new Error(`asset archive: ${path} sets ${name}, which the server derives`);
      }
      if (name === "set-cookie") {
        continue;
      }
      pairs.push([name, value]);
    }
    for (const cookie of headers.getSetCookie()) {
      pairs.push(["set-cookie", cookie]);
    }
    if (brotli) {
      const vary = pairs.find(([name]) => name === "vary");
      if (!vary) {
        pairs.push(["vary", "accept-encoding"]);
      } else if (!/(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(vary[1])) {
        vary[1] += ", accept-encoding";
      }
    }
    const key = JSON.stringify(pairs);
    let index = this.#byKey.get(key);
    if (index === undefined) {
      index = this.sets.length;
      this.sets.push(pairs);
      this.#byKey.set(key, index);
    }
    return index;
  }
}

/** Strings referenced by offset and length, each stored once. */
class StringTable {
  #byText = new Map<string, number>();

  chunks: Buffer[] = [];
  size = 0;

  add(text: string): [number, number] {
    const bytes = utf8(text);
    let offset = this.#byText.get(text);
    if (offset === undefined) {
      offset = this.size;
      this.#byText.set(text, offset);
      this.chunks.push(bytes);
      this.size += bytes.length;
    }
    return [offset, bytes.length];
  }
}

const pad = (size: number): number => (8 - (size % 8)) % 8;
const aligned = (size: number): number => size + pad(size);

function encode(entries: Stored[], sets: HeaderSets, data: DataSection): Buffer {
  const strings = new StringTable();
  const paths = entries.map((entry) => strings.add(entry.path));
  const pairs: [number, number, number, number][] = [];
  const setRecords: [number, number][] = [];
  for (const set of sets.sets) {
    setRecords.push([pairs.length, set.length]);
    for (const [name, value] of set) {
      pairs.push([...strings.add(name), ...strings.add(value)]);
    }
  }

  const entryOffset = HEADER_SIZE;
  const setOffset = entryOffset + aligned(entries.length * ENTRY_SIZE);
  const pairOffset = setOffset + aligned(setRecords.length * SET_SIZE);
  const stringOffset = pairOffset + aligned(pairs.length * PAIR_SIZE);
  const dataOffset = stringOffset + aligned(strings.size);
  const archive = Buffer.alloc(dataOffset + data.size);

  archive.write(MAGIC, 0, "latin1");
  archive.writeUInt16LE(VERSION, 4);
  archive.writeUInt16LE(0, 6);
  archive.writeUInt32LE(entries.length, 8);
  archive.writeUInt32LE(setRecords.length, 12);
  archive.writeUInt32LE(pairs.length, 16);
  archive.writeBigUInt64LE(BigInt(entryOffset), 24);
  archive.writeBigUInt64LE(BigInt(setOffset), 32);
  archive.writeBigUInt64LE(BigInt(pairOffset), 40);
  archive.writeBigUInt64LE(BigInt(stringOffset), 48);
  archive.writeBigUInt64LE(BigInt(strings.size), 56);
  archive.writeBigUInt64LE(BigInt(dataOffset), 64);
  archive.writeBigUInt64LE(BigInt(data.size), 72);

  entries.forEach((entry, index) => {
    const at = entryOffset + index * ENTRY_SIZE;
    const [pathOffset, pathLength] = paths[index]!;
    archive.writeUInt32LE(pathOffset, at);
    archive.writeUInt32LE(pathLength, at + 4);
    archive.writeBigUInt64LE(BigInt(entry.data.offset), at + 8);
    archive.writeBigUInt64LE(BigInt(entry.data.stored.length), at + 16);
    archive.writeBigUInt64LE(BigInt(entry.data.rawSize), at + 24);
    archive.writeUInt32LE(entry.headerSet, at + 32);
    archive.writeUInt16LE(entry.status, at + 36);
    archive.writeUInt16LE(
      (entry.data.brotli ? FLAG_BROTLI : 0) | (entry.keepQuery ? FLAG_KEEP_QUERY : 0),
      at + 38,
    );
    entry.data.hash.copy(archive, at + 40);
  });
  setRecords.forEach(([first, count], index) => {
    archive.writeUInt32LE(first, setOffset + index * SET_SIZE);
    archive.writeUInt32LE(count, setOffset + index * SET_SIZE + 4);
  });
  pairs.forEach((pair, index) => {
    pair.forEach((value, field) =>
      archive.writeUInt32LE(value, pairOffset + index * PAIR_SIZE + field * 4),
    );
  });
  Buffer.concat(strings.chunks).copy(archive, stringOffset);
  Buffer.concat(data.chunks).copy(archive, dataOffset);
  return archive;
}
