// Helpers that build asset archive entries: from a client directory, with
// the routes, caching and responses an adapter or app configures.

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { AssetEntry } from "./asset-archive.ts";

/** Media types by extension, for the default `Content-Type`. */
const CONTENT_TYPE_MAP: ReadonlyMap<string, string> = new Map([
  ["avif", "image/avif"],
  ["css", "text/css; charset=utf-8"],
  ["gif", "image/gif"],
  ["htm", "text/html; charset=utf-8"],
  ["html", "text/html; charset=utf-8"],
  ["ico", "image/x-icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["js", "text/javascript; charset=utf-8"],
  ["json", "application/json"],
  ["jxl", "image/jxl"],
  ["map", "application/json"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
  ["otf", "font/otf"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["ttf", "font/ttf"],
  ["txt", "text/plain; charset=utf-8"],
  ["wasm", "application/wasm"],
  ["webm", "video/webm"],
  ["webmanifest", "application/manifest+json"],
  ["webp", "image/webp"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["xml", "application/xml"],
]);

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** `Cache-Control` for files whose names change with their contents. */
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** A `Cache-Control` value for the paths under `prefix`. */
export interface CacheRule {
  prefix: string;
  cacheControl: string;
}

/** A file or directory under the client directory, as `include` sees it. */
export interface AssetPathInfo {
  /** Its path from the client directory, starting with `/`, such as `/.vite`. */
  path: string;
  directory: boolean;
}

/**
 * Decide whether a file or directory goes into the archive. A directory left
 * out is not read. `defaults` is the default decision, including the
 * framework's.
 */
export type AssetInclude = (entry: AssetPathInfo, defaults: boolean) => boolean;

/** One served file, as the `respond` function sees it. */
export interface AssetInfo {
  /** The canonical URL path, starting with `/`, such as `/assets/app.js`. */
  path: string;
  /** The file on disk. */
  file: string;
  /** The file size in bytes. */
  size: number;
  /**
   * The default headers: `Content-Type` from the extension and
   * `Cache-Control` from the matching cache rule.
   */
  headers: Headers;
}

/**
 * Decide what a file serves. `Headers`, or `undefined` for `info.headers`,
 * serves the file with status 200; a `Response` is stored in place of the
 * file, with its status, headers and body; `null` leaves the file out.
 */
export type AssetResponder = (
  info: AssetInfo,
) => Headers | Response | null | undefined | Promise<Headers | Response | null | undefined>;

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

/** How `directoryAssets` turns files into entries. */
export interface DirectoryAssetOptions {
  /** Which files and directories to read. Defaults to `defaultAssetInclude`. */
  include?: AssetInclude;
  routes?: AssetRoutes;
  /** `Cache-Control` by the longest matching prefix, applied before `respond`. */
  cache?: CacheRule[];
  respond?: AssetResponder;
}

/**
 * The default `include`: dot-named files and directories, such as Vite's
 * `.vite/` manifests, are build metadata and left out; `.well-known/` is
 * served.
 */
export function defaultAssetInclude({ path }: AssetPathInfo): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return !name.startsWith(".") || name === ".well-known";
}

/** The `Content-Type` for a path, from its extension. */
export function contentType(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_MAP.get(extension) ?? FALLBACK_CONTENT_TYPE;
}

/** An entry that redirects `from` to `to`, keeping the request's query. */
export function redirect(
  from: string,
  to: string,
  status: 301 | 302 | 303 | 307 | 308 = 308,
): AssetEntry {
  return {
    path: from,
    status,
    headers: {
      location: to,
    },
    appendQuery: true,
  };
}

/**
 * The entries for the files under `directory`: each file at the paths its
 * route serves, and redirects to them. A file served at a path takes
 * precedence over a redirect there.
 */
export async function directoryAssets(
  directory: string,
  { include, routes = {}, cache = [], respond }: DirectoryAssetOptions = {},
): Promise<AssetEntry[]> {
  const root = resolve(directory);
  const rules = [...cache].sort((a, b) => b.prefix.length - a.prefix.length);
  const entries: AssetEntry[] = [];
  const served = new Set<string>();
  const redirects = new Map<string, AssetEntry>();
  for (const file of listFiles(root, root, include)) {
    const filePath = "/" + relative(root, file).split(sep).join("/");
    const route = planRoute(filePath, routes);
    const headers = new Headers({
      "content-type": contentType(filePath),
    });
    const rule = rules.find(({ prefix }) => route.path.startsWith(prefix));
    if (rule) {
      headers.set("cache-control", rule.cacheControl);
    }
    const decision = respond
      ? await respond({
          path: route.path,
          file,
          size: statSync(file).size,
          headers,
        })
      : headers;
    if (decision === null) {
      continue;
    }
    const response: Omit<AssetEntry, "path"> =
      decision instanceof Response
        ? {
            status: decision.status,
            headers: decision.headers,
            body: new Uint8Array(await decision.arrayBuffer()),
          }
        : {
            headers: decision ?? headers,
            body: {
              file,
            },
          };
    for (const path of [route.path, ...route.aliases]) {
      entries.push({
        path,
        ...response,
      });
      served.add(path);
    }
    for (const path of route.redirects) {
      redirects.set(path, redirect(path, route.path));
    }
  }
  for (const [path, entry] of redirects) {
    if (!served.has(path)) {
      entries.push(entry);
    }
  }
  return entries;
}

/** The files under `directory` that `include` admits, in name order. */
function listFiles(root: string, directory: string, include: AssetInclude | undefined): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const isDirectory = statSync(path).isDirectory();
    const info = {
      path: "/" + relative(root, path).split(sep).join("/"),
      directory: isDirectory,
    };
    const defaults = defaultAssetInclude(info);
    if (!(include ? include(info, defaults) : defaults)) {
      continue;
    }
    if (isDirectory) {
      files.push(...listFiles(root, path, include));
    } else {
      files.push(path);
    }
  }
  return files;
}

/**
 * The URL paths a file answers: its canonical path, other paths that serve
 * it too, and paths that redirect to the canonical one.
 */
function planRoute(
  file: string,
  { trailingSlash = "always", htmlExtension = "keep" }: AssetRoutes = {},
): {
  path: string;
  aliases: string[];
  redirects: string[];
} {
  const aliases: string[] = [];
  const redirects: string[] = [];
  const extension = (path: string) => (htmlExtension === "keep" ? aliases : redirects).push(path);
  let base: string;
  if (file === "/index.html") {
    extension(file);
    return {
      path: "/",
      aliases,
      redirects,
    };
  } else if (file.endsWith("/index.html")) {
    base = file.slice(0, -"/index.html".length);
    extension(file);
  } else if (file.endsWith(".html") && htmlExtension === "strip") {
    base = file.slice(0, -".html".length);
    redirects.push(file);
  } else {
    return {
      path: file,
      aliases,
      redirects,
    };
  }
  const slashed = base + "/";
  switch (trailingSlash) {
    case "always":
      redirects.push(base);
      return {
        path: slashed,
        aliases,
        redirects,
      };

    case "never":
      redirects.push(slashed);
      return {
        path: base,
        aliases,
        redirects,
      };

    case "ignore":
      aliases.push(file.endsWith("/index.html") ? base : slashed);
      return {
        path: file.endsWith("/index.html") ? slashed : base,
        aliases,
        redirects,
      };
  }
}
