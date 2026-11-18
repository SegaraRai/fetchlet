// File URL helpers for POSIX paths, and urlToHttpOptions.

import { invalidArgType, nodeError } from "../errors/errors.ts";
import { resolve as resolvePath } from "../path/posix.ts";
import { URL } from "./whatwg.ts";

export function fileURLToPath(path: string | URL, _options?: { windows?: boolean }): string {
  let url: URL;
  if (typeof path === "string") {
    url = new URL(path);
  } else if (path instanceof URL) {
    url = path;
  } else {
    throw invalidArgType("path", "of type string or an instance of URL", path);
  }
  if (url.protocol !== "file:") {
    throw nodeError(TypeError, "ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
  }
  if (url.hostname !== "") {
    throw nodeError(
      TypeError,
      "ERR_INVALID_FILE_URL_HOST",
      'File URL host must be "localhost" or empty on linux',
    );
  }
  const { pathname } = url;
  if (/%2f/i.test(pathname)) {
    throw nodeError(
      TypeError,
      "ERR_INVALID_FILE_URL_PATH",
      "File URL path must not include encoded / characters",
    );
  }
  return decodeURIComponent(pathname);
}

export function pathToFileURL(filepath: string, _options?: { windows?: boolean }): URL {
  if (typeof filepath !== "string") {
    throw invalidArgType("path", "of type string", filepath);
  }
  let resolved = resolvePath(filepath);
  // resolve drops a trailing slash, which names a directory.
  if (filepath.endsWith("/") && !resolved.endsWith("/")) {
    resolved += "/";
  }
  const escaped = resolved
    .replaceAll("%", "%25")
    .replaceAll("\\", "%5C")
    .replaceAll("\n", "%0A")
    .replaceAll("\r", "%0D")
    .replaceAll("\t", "%09")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F");
  const url = new URL("file://");
  url.pathname = escaped;
  return url;
}

export function urlToHttpOptions(url: URL): Record<string, unknown> {
  const options: Record<string, unknown> = {
    protocol: url.protocol,
    hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ""}${url.search || ""}`,
    href: url.href,
  };
  if (url.port !== "") {
    options.port = Number(url.port);
  }
  if (url.username || url.password) {
    options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  }
  return options;
}
