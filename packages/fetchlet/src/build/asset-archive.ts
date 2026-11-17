// Writes an artifact's client assets as one archive that Rust serves directly.
// The format is described in docs/asset-archive.md.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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

/** Media types by extension, for the default `Content-Type`. */
const CONTENT_TYPES: Record<string, string> = {
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  jxl: "image/jxl",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webm: "video/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};

/** One served path, as the `respond` function sees it. */
export interface AssetInfo {
  /** The canonical URL path, starting with `/`, such as `/assets/app.js`. */
  path: string;
  /** The file on disk. */
  file: string;
  /** The file size in bytes. */
  size: number;
  /** The default headers: `Content-Type` from the extension. */
  headers: Headers;
}

/**
 * Decide what a path serves. `Headers`, or `undefined` for `info.headers`,
 * serves the file with status 200; a `Response` is stored in place of the
 * file, with its status, headers and body.
 */
export type AssetResponder = (
  info: AssetInfo,
) => Headers | Response | undefined | Promise<Headers | Response | undefined>;

/**
 * How HTML files map to URL paths. Other files are served at their own path.
 *
 * - `trailingSlash` applies to `dir/index.html`, and with `htmlExtension:
 *   "strip"` to `page.html`: `"always"` serves `/dir/` and redirects `/dir`;
 *   `"never"` serves `/dir` and redirects `/dir/`; `"ignore"` serves both.
 *   Defaults to `"always"`, as tower-http's ServeDir.
 * - `htmlExtension`: `"keep"` also serves `/dir/index.html` and serves
 *   `page.html` at `/page.html`; `"strip"` serves `page.html` at `/page` and
 *   redirects the `.html` paths. Defaults to `"keep"`.
 *
 * `/index.html` always serves `/`. Redirects are 308 and keep the query.
 */
export interface AssetRoutes {
  trailingSlash?: "always" | "never" | "ignore";
  htmlExtension?: "keep" | "strip";
}

export interface WriteAssetArchiveOptions {
  /** The directory of client assets, such as `build/client`. */
  directory: string;
  /** The archive file to write. */
  out: string;
  respond?: AssetResponder;
  routes?: AssetRoutes;
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

/** Write the files under `directory` as an asset archive at `out`. */
export async function writeAssetArchive({
  directory,
  out,
  respond = (info) => info.headers,
  routes = {},
}: WriteAssetArchiveOptions): Promise<AssetArchiveSummary> {
  const root = resolve(directory);
  const sets = new HeaderSets();
  const data = new DataSection();
  const served = new Map<string, Stored>();
  const redirects = new Map<string, Stored>();
  const serve = (entry: Stored, file: string) => {
    if (served.has(entry.path)) {
      throw new Error(`asset archive: ${entry.path} is served twice, the second time by ${file}`);
    }
    served.set(entry.path, entry);
  };

  for (const file of listFiles(root)) {
    const filePath = "/" + relative(root, file).split(sep).join("/");
    const route = planRoute(filePath, routes);
    const raw = readFileSync(file);
    const defaults = new Headers({
      "content-type": contentType(filePath),
    });
    const decision =
      (await respond({
        path: route.path,
        file,
        size: raw.length,
        headers: defaults,
      })) ?? defaults;
    let status = 200;
    let body: Buffer = raw;
    let responseHeaders: Headers;
    if (decision instanceof Response) {
      status = decision.status;
      responseHeaders = decision.headers;
      body = Buffer.from(await decision.arrayBuffer());
    } else {
      responseHeaders = decision;
    }
    const stored = data.add(body);
    const headerSet = sets.add(route.path, responseHeaders, stored.brotli);
    for (const path of [route.path, ...route.aliases]) {
      serve({ path, status, headerSet, data: stored, keepQuery: false }, file);
    }
    for (const path of route.redirects) {
      redirects.set(path, {
        path,
        status: 308,
        headerSet: sets.add(path, new Headers({ location: route.path }), false),
        data: data.add(Buffer.alloc(0)),
        keepQuery: true,
      });
    }
  }
  // A file served at a path takes precedence over a redirect to another file.
  for (const [path, redirect] of redirects) {
    if (!served.has(path)) {
      served.set(path, redirect);
    }
  }

  const sorted = [...served.values()].sort((a, b) => Buffer.compare(utf8(a.path), utf8(b.path)));
  const archive = encode(sorted, sets, data);
  writeFileSync(out, archive);
  return {
    entries: sorted.length,
    rawBytes: data.rawBytes,
    storedBytes: data.storedBytes,
  };
}

/**
 * The URL paths a file answers: its canonical path, other paths that serve
 * it too, and paths that redirect to the canonical one.
 */
function planRoute(
  file: string,
  { trailingSlash = "always", htmlExtension = "keep" }: AssetRoutes = {},
): { path: string; aliases: string[]; redirects: string[] } {
  const aliases: string[] = [];
  const redirects: string[] = [];
  const extension = (path: string) => (htmlExtension === "keep" ? aliases : redirects).push(path);
  let base: string;
  if (file === "/index.html") {
    extension(file);
    return { path: "/", aliases, redirects };
  } else if (file.endsWith("/index.html")) {
    base = file.slice(0, -"/index.html".length);
    extension(file);
  } else if (file.endsWith(".html") && htmlExtension === "strip") {
    base = file.slice(0, -".html".length);
    redirects.push(file);
  } else {
    return { path: file, aliases, redirects };
  }
  const slashed = base + "/";
  switch (trailingSlash) {
    case "always":
      redirects.push(base);
      return { path: slashed, aliases, redirects };
    case "never":
      redirects.push(slashed);
      return { path: base, aliases, redirects };
    case "ignore":
      aliases.push(file.endsWith("/index.html") ? base : slashed);
      return { path: file.endsWith("/index.html") ? slashed : base, aliases, redirects };
  }
}

/**
 * The files under `directory`, without dot-named files and directories such
 * as Vite's `.vite/` manifests, which are build metadata. `.well-known/` is
 * served.
 */
function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith(".") && name !== ".well-known") {
      continue;
    }
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function contentType(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
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

export interface ArchiveArtifactAssetsOptions {
  /** The artifact directory that `buildArtifact` wrote. */
  outDir: string;
  respond?: AssetResponder;
  routes?: AssetRoutes;
}

/**
 * Archive an artifact's client directory as `assets.flpk` and name it in
 * fetchlet.json, so `Artifact::asset_archive` in fetchlet-http finds it.
 */
export async function archiveArtifactAssets({
  outDir,
  respond,
  routes,
}: ArchiveArtifactAssetsOptions): Promise<AssetArchiveSummary> {
  const manifestPath = join(outDir, "fetchlet.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    client?: string;
    assets?: string;
  };
  if (!manifest.client) {
    throw new Error(`asset archive: ${manifestPath} names no client directory`);
  }
  const summary = await writeAssetArchive({
    directory: join(outDir, manifest.client),
    out: join(outDir, "assets.flpk"),
    ...(respond ? { respond } : {}),
    ...(routes ? { routes } : {}),
  });
  manifest.assets = "assets.flpk";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return summary;
}

/** `Cache-Control` for files whose names change with their contents. */
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** A `Cache-Control` value for the paths under `prefix`. */
export interface CacheRule {
  prefix: string;
  cacheControl: string;
}

/** The settings adapters take as `assets`. */
export interface AssetArchiveSettings {
  respond?: AssetResponder;
  routes?: AssetRoutes;
}

/**
 * An adapter's `assets` option with its framework's defaults: `cache` sets
 * `Cache-Control` by the longest matching prefix before the caller's
 * `respond` runs, and `routes` applies unless the caller sets its own.
 */
export function frameworkAssets(
  settings: true | AssetArchiveSettings,
  defaults: { cache?: CacheRule[]; routes?: AssetRoutes },
): AssetArchiveSettings {
  const { respond, routes = defaults.routes } = settings === true ? {} : settings;
  const cache = [...(defaults.cache ?? [])].sort((a, b) => b.prefix.length - a.prefix.length);
  return {
    ...(routes ? { routes } : {}),
    respond(info) {
      const rule = cache.find(({ prefix }) => info.path.startsWith(prefix));
      if (rule) {
        info.headers.set("cache-control", rule.cacheControl);
      }
      return respond ? respond(info) : info.headers;
    },
  };
}
