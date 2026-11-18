// The legacy Url API (parse, format, resolve) following Node's lib/url.js.

import { invalidArgType, nodeError } from "../errors/errors.ts";
import * as querystring from "../querystring/querystring.ts";
import { domainToASCII, domainToUnicode } from "./domain.ts";
import { URL } from "./whatwg.ts";

const slashedProtocols = new Set(["http", "https", "ftp", "gopher", "file"]);
const hostlessProtocols = new Set(["javascript"]);
const unsafeProtocols = new Set(["javascript"]);
const protocolPattern = /^[a-z0-9.+-]+:/i;
const portPattern = /:[0-9]*$/;
const simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;
const forbiddenHostChars = /[\0\t\n\r #%/:<>?@[\\\]^|]/;
const forbiddenHostCharsIpv6 = /[\0\t\n\r #%/<>?@\\^|]/;

const autoEscape: Record<string, string> = {
  "\t": "%09",
  "\n": "%0A",
  "\r": "%0D",
  " ": "%20",
  '"': "%22",
  "'": "%27",
  "<": "%3C",
  ">": "%3E",
  "\\": "%5C",
  "^": "%5E",
  "`": "%60",
  "{": "%7B",
  "|": "%7C",
  "}": "%7D",
};

const isWhitespace = (code: number) =>
  code === 0x20 ||
  code === 0x09 ||
  code === 0x0a ||
  code === 0x0c ||
  code === 0x0d ||
  code === 0xa0 ||
  code === 0xfeff;

function invalidUrl(input: string) {
  const error = nodeError(TypeError, "ERR_INVALID_URL", "Invalid URL") as TypeError & {
    input?: string;
  };
  error.input = input;
  return error;
}

export class Url {
  protocol: string | null = null;
  slashes: boolean | null = null;
  auth: string | null = null;
  host: string | null = null;
  port: string | null = null;
  hostname: string | null = null;
  hash: string | null = null;
  search: string | null = null;
  query: string | Record<string, unknown> | null = null;
  pathname: string | null = null;
  path: string | null = null;
  href: string | null = null;

  parse(url: string, parseQueryString = false, slashesDenoteHost = false): this {
    if (typeof url !== "string") {
      throw invalidArgType("url", "of type string", url);
    }
    // Trim whitespace and convert backslashes before the query to slashes.
    let start = 0;
    let end = url.length;
    while (start < end && isWhitespace(url.charCodeAt(start))) {
      start += 1;
    }
    while (end > start && isWhitespace(url.charCodeAt(end - 1))) {
      end -= 1;
    }
    let rest = "";
    let split = false;
    let hasHash = false;
    for (let index = start; index < end; index += 1) {
      const char = url[index];
      if (!split && char === "\\") {
        rest += "/";
        continue;
      }
      if (char === "#") {
        hasHash = true;
        split = true;
      } else if (char === "?") {
        split = true;
      }
      rest += char;
    }

    if (!slashesDenoteHost && !hasHash) {
      const simplePath = simplePathPattern.exec(rest);
      if (simplePath) {
        this.path = rest;
        this.href = rest;
        this.pathname = simplePath[1];
        if (simplePath[2]) {
          this.search = simplePath[2];
          this.query = parseQueryString
            ? querystring.parse(this.search.slice(1))
            : this.search.slice(1);
        } else if (parseQueryString) {
          this.search = null;
          this.query = Object.create(null) as Record<string, unknown>;
        }
        return this;
      }
    }

    let protocol: string | undefined;
    let lowerProtocol: string | undefined;
    const match = protocolPattern.exec(rest);
    if (match) {
      lowerProtocol = match[0].toLowerCase();
      protocol = match[0];
      this.protocol = lowerProtocol;
      rest = rest.slice(match[0].length);
      lowerProtocol = lowerProtocol.slice(0, -1);
    }

    let slashes = false;
    if (slashesDenoteHost || protocol || /^\/\/[^@/]+@[^@/]+/.test(rest)) {
      slashes = rest.startsWith("//") && !(protocol && hostlessProtocols.has(lowerProtocol!));
      if (slashes) {
        rest = rest.slice(2);
        this.slashes = true;
      }
    }

    if (
      !hostlessProtocols.has(lowerProtocol ?? "") &&
      (slashes || (protocol && !slashedProtocols.has(lowerProtocol!)))
    ) {
      let hostEnd = -1;
      let atSign = -1;
      let nonHost = -1;
      for (let index = 0; index < rest.length && hostEnd === -1; index += 1) {
        switch (rest[index]) {
          case "\t":
          case "\n":
          case "\r":
          case " ":
          case '"':
          case "%":
          case "'":
          case ";":
          case "<":
          case ">":
          case "\\":
          case "^":
          case "`":
          case "{":
          case "|":
          case "}":
            if (nonHost === -1) {
              nonHost = index;
            }
            break;
          case "#":
          case "/":
          case "?":
            if (nonHost === -1) {
              nonHost = index;
            }
            hostEnd = index;
            break;
          case "@":
            atSign = index;
            nonHost = -1;
            break;
        }
      }
      let hostStart = 0;
      if (atSign !== -1) {
        this.auth = decodeURIComponent(rest.slice(0, atSign));
        hostStart = atSign + 1;
      }
      if (nonHost === -1) {
        this.host = rest.slice(hostStart);
        rest = "";
      } else {
        this.host = rest.slice(hostStart, nonHost);
        rest = rest.slice(nonHost);
      }

      this.#parseHost();
      if (typeof this.hostname !== "string") {
        this.hostname = "";
      }
      const hostname: string = this.hostname;
      const ipv6Hostname = hostname.startsWith("[") && hostname.endsWith("]");
      if (!ipv6Hostname) {
        for (let index = 0; index < hostname.length; index += 1) {
          if ("/\\#?:".includes(hostname[index])) {
            this.hostname = hostname.slice(0, index);
            rest = `/${hostname.slice(index)}${rest}`;
            break;
          }
        }
      }
      this.hostname = this.hostname.length > 255 ? "" : this.hostname.toLowerCase();
      if (this.hostname !== "") {
        if (ipv6Hostname) {
          if (forbiddenHostCharsIpv6.test(this.hostname)) {
            throw invalidUrl(url);
          }
        } else {
          if (/[^\0-\x7f]/.test(this.hostname)) {
            this.hostname = domainToASCII(this.hostname);
          }
          if (forbiddenHostChars.test(this.hostname)) {
            throw invalidUrl(url);
          }
        }
      }
      const port = this.port ? `:${this.port}` : "";
      this.host = `${this.hostname}${port}`;
      if (ipv6Hostname) {
        this.hostname = this.hostname.slice(1, -1);
        if (!rest.startsWith("/")) {
          rest = `/${rest}`;
        }
      }
    }

    if (!unsafeProtocols.has(lowerProtocol ?? "")) {
      rest = rest.replace(/[\t\n\r "'<>\\^`{|}]/g, (char) => autoEscape[char]);
    }

    const hashIndex = rest.indexOf("#");
    if (hashIndex !== -1) {
      this.hash = rest.slice(hashIndex);
      rest = rest.slice(0, hashIndex);
    }
    const questionIndex = rest.indexOf("?");
    if (questionIndex !== -1) {
      this.search = rest.slice(questionIndex);
      this.query = rest.slice(questionIndex + 1);
      if (parseQueryString) {
        this.query = querystring.parse(this.query);
      }
      rest = rest.slice(0, questionIndex);
    } else if (parseQueryString) {
      this.search = null;
      this.query = Object.create(null) as Record<string, unknown>;
    }

    if (rest.length > 0) {
      this.pathname = rest;
    } else if (slashedProtocols.has(lowerProtocol ?? "") && this.hostname && !this.pathname) {
      this.pathname = "/";
    }
    if (this.pathname || this.search) {
      this.path = `${this.pathname ?? ""}${this.search ?? ""}`;
    }
    this.href = this.format();
    return this;
  }

  #parseHost() {
    let host = this.host ?? "";
    const port = portPattern.exec(host);
    if (port) {
      if (port[0] !== ":") {
        this.port = port[0].slice(1);
      }
      host = host.slice(0, host.length - port[0].length);
    }
    if (host) {
      this.hostname = host;
    }
  }

  format(): string {
    let auth = this.auth ?? "";
    if (auth) {
      auth = `${encodeURIComponent(auth).replace(/%3A/i, ":")}@`;
    }
    let protocol = this.protocol ?? "";
    let pathname = this.pathname ?? "";
    let hash = this.hash ?? "";
    let host = "";
    let query = "";
    if (this.host) {
      host = auth + this.host;
    } else if (this.hostname) {
      host =
        auth +
        (this.hostname.includes(":") && !this.hostname.startsWith("[")
          ? `[${this.hostname}]`
          : this.hostname);
      if (this.port) {
        host += `:${this.port}`;
      }
    }
    if (this.query !== null && typeof this.query === "object") {
      query = querystring.stringify(this.query);
    }
    let search = this.search || (query && `?${query}`) || "";
    if (protocol && !protocol.endsWith(":")) {
      protocol += ":";
    }
    pathname = pathname.replaceAll("#", "%23").replaceAll("?", "%3F");
    if (this.slashes || slashedProtocols.has(protocol.slice(0, -1))) {
      if (this.slashes || host) {
        if (pathname && !pathname.startsWith("/")) {
          pathname = `/${pathname}`;
        }
        host = `//${host}`;
      } else if (protocol === "file:" && pathname.startsWith("/")) {
        host = "//";
      }
    }
    search = search.replaceAll("#", "%23");
    if (hash && !hash.startsWith("#")) {
      hash = `#${hash}`;
    }
    if (search && !search.startsWith("?")) {
      search = `?${search}`;
    }
    return protocol + host + pathname + search + hash;
  }

  resolve(relative: string): string {
    return resolveUrl(this.format(), relative);
  }
}

export function parse(
  url: string | Url,
  parseQueryString?: boolean,
  slashesDenoteHost?: boolean,
): Url {
  if (url instanceof Url) {
    return url;
  }
  return new Url().parse(url, parseQueryString, slashesDenoteHost);
}

interface FormatOptions {
  auth?: boolean;
  fragment?: boolean;
  search?: boolean;
  unicode?: boolean;
}

export function format(urlObject: string | URL | Url | object, options?: FormatOptions): string {
  if (typeof urlObject === "string") {
    return parse(urlObject).format();
  }
  if (urlObject === null || typeof urlObject !== "object") {
    throw invalidArgType("urlObject", "of type object or string", urlObject);
  }
  if (urlObject instanceof URL) {
    const { auth = true, fragment = true, search = true, unicode = false } = options ?? {};
    const copy = new URL(urlObject.href);
    if (!auth) {
      copy.username = "";
      copy.password = "";
    }
    if (!fragment) {
      copy.hash = "";
    }
    if (!search) {
      copy.search = "";
    }
    if (unicode) {
      const host = domainToUnicode(copy.hostname);
      return copy.href.replace(copy.hostname, host);
    }
    return copy.href;
  }
  return Url.prototype.format.call(urlObject as Url);
}

// A base that names no real host, for resolving relative references.
const RELATIVE_BASE = "fetchlet-relative://base";

/**
 * Resolves `to` against `from` with WHATWG URL resolution, keeping a
 * relative `from` relative.
 */
function resolveUrl(from: string, to: string): string {
  let base: URL;
  let relative = false;
  try {
    base = new URL(from);
  } catch {
    relative = true;
    base = new URL(from, `${RELATIVE_BASE}/`);
  }
  const resolved = new URL(to, base);
  if (!relative || resolved.origin !== new URL(RELATIVE_BASE).origin) {
    return resolved.href;
  }
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  // Keep a relative base's lack of a leading slash.
  return from.startsWith("/") || to.startsWith("/") ? path : path.slice(1);
}

export function resolve(from: string, to: string): string {
  return resolveUrl(from, to);
}

export function resolveObject(source: string | Url, relative: string): Url {
  const from = typeof source === "string" ? source : source.format();
  return parse(resolveUrl(from, relative));
}
