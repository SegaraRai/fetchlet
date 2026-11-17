import { decode } from "./bytes";

/** One parsed `multipart/form-data` part. */
export interface MultipartEntry {
  name: string;
  /** Present for file parts, including an empty filename. */
  filename?: string;
  contentType?: string;
  value: Uint8Array;
}

const CR = 0x0d;
const LF = 0x0a;
const HYPHEN = 0x2d;
const SPACE = 0x20;
const TAB = 0x09;

function invalid(reason: string): never {
  throw new TypeError("Invalid multipart/form-data body: " + reason);
}

function ascii(text: string) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function indexOf(bytes: Uint8Array, pattern: Uint8Array, from: number) {
  const first = pattern[0]!;
  const last = bytes.length - pattern.length;
  for (let index = bytes.indexOf(first, from); index !== -1 && index <= last;) {
    let offset = 1;
    while (offset < pattern.length && bytes[index + offset] === pattern[offset]) {
      offset += 1;
    }
    if (offset === pattern.length) {
      return index;
    }
    index = bytes.indexOf(first, index + 1);
  }
  return -1;
}

const isToken = (text: string) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(text);

/** The lowercase type/subtype of a MIME type string. */
export function essence(contentType: string) {
  return (splitParameters(contentType)[0] ?? "").trim().toLowerCase();
}

/**
 * The boundary parameter of a `multipart/form-data` MIME type, or null for
 * another type. Type and parameter names compare case-insensitively.
 */
export function multipartBoundary(contentType: string): string | null {
  const [essence = "", ...parameters] = splitParameters(contentType);
  if (essence.trim().toLowerCase() !== "multipart/form-data") {
    return null;
  }
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0 || parameter.slice(0, separator).trim().toLowerCase() !== "boundary") {
      continue;
    }
    const boundary = unquote(parameter.slice(separator + 1).trim());
    // RFC 2046 §5.1.1: 1 to 70 characters, not ending with a space.
    if (boundary.length === 0 || boundary.length > 70 || boundary.endsWith(" ")) {
      return null;
    }
    return boundary;
  }
  return null;
}

// Split on semicolons outside quoted strings.
function splitParameters(text: string) {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted && character === "\\" && index + 1 < text.length) {
      current += character + text[++index];
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
    }
    if (character === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts;
}

function unquote(value: string) {
  if (!value.startsWith('"')) {
    return value;
  }
  let result = "";
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\" && index + 1 < value.length) {
      result += value[++index];
    } else if (character === '"') {
      return result;
    } else {
      result += character;
    }
  }
  return result;
}

// HTML's form encoding escapes these three characters in names and filenames.
function unescapeFieldName(value: string) {
  return value.replace(/%(0D|0A|22)/gi, (match) => decodeURIComponent(match));
}

function parseHeaders(block: Uint8Array) {
  let disposition: string | undefined;
  let contentType: string | undefined;
  for (const line of decode(block).split("\r\n")) {
    const separator = line.indexOf(":");
    const name = separator < 0 ? "" : line.slice(0, separator);
    if (!isToken(name)) {
      invalid("malformed part header");
    }
    const value = line.slice(separator + 1).trim();
    switch (name.toLowerCase()) {
      case "content-disposition":
        disposition = value;
        break;

      case "content-type":
        contentType = value;
        break;
    }
  }
  if (disposition === undefined) {
    invalid("a part has no Content-Disposition");
  }
  const [type = "", ...parameters] = splitParameters(disposition);
  if (type.trim().toLowerCase() !== "form-data") {
    invalid("a part is not form-data");
  }
  let name: string | undefined;
  let filename: string | undefined;
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = parameter.slice(0, separator).trim().toLowerCase();
    const value = unescapeFieldName(unquote(parameter.slice(separator + 1).trim()));
    if (key === "name") {
      name ??= value;
    }
    if (key === "filename") {
      filename ??= value;
    }
  }
  if (name === undefined) {
    invalid("a part has no name");
  }
  return {
    name,
    filename,
    contentType,
  };
}

/**
 * Parse a complete `multipart/form-data` body (RFC 7578, RFC 2046 §5.1).
 *
 * Delimiters are recognized only at the start of a line. Preamble and epilogue
 * are ignored; a missing close delimiter or malformed part is a TypeError.
 */
interface Delimiter {
  /** Offset of the CRLF that starts the delimiter. */
  at: number;
  /** Offset after the delimiter line. */
  end: number;
  close: boolean;
}

export function parseMultipart(bytes: Uint8Array, boundary: string): MultipartEntry[] {
  const delimiter = ascii("\r\n--" + boundary);
  const headerEnd = ascii("\r\n\r\n");
  const entries: MultipartEntry[] = [];

  // A delimiter line is "--boundary" followed by "--" (close delimiter) or by
  // optional transport padding and CRLF. RFC 2046 forbids the delimiter inside
  // content, so other text after the boundary at a line start is an error.
  function nextDelimiter(from: number): Delimiter {
    const at = indexOf(bytes, delimiter, from);
    if (at < 0) {
      invalid("no closing boundary");
    }
    let position = at + delimiter.length;
    if (bytes[position] === HYPHEN && bytes[position + 1] === HYPHEN) {
      return {
        at,
        end: position + 2,
        close: true,
      };
    }
    while (bytes[position] === SPACE || bytes[position] === TAB) {
      position += 1;
    }
    if (bytes[position] !== CR || bytes[position + 1] !== LF) {
      invalid("malformed delimiter line");
    }
    return {
      at,
      end: position + 2,
      close: false,
    };
  }

  // The first delimiter may start the body or follow a preamble line. Treat
  // the body as if preceded by CRLF so both cases share one search.
  const prefixed = new Uint8Array(bytes.length + 2);
  prefixed.set([CR, LF]);
  prefixed.set(bytes, 2);
  bytes = prefixed;
  let line = nextDelimiter(0);

  while (!line.close) {
    const position = line.end;
    if (bytes[position] === CR && bytes[position + 1] === LF) {
      invalid("a part has no headers");
    }
    const headersEnd = indexOf(bytes, headerEnd, position);
    if (headersEnd < 0) {
      invalid("unterminated part headers");
    }
    const headers = parseHeaders(bytes.subarray(position, headersEnd));
    // An empty part's delimiter shares the CRLF that ends its headers.
    const next = nextDelimiter(headersEnd + 2);
    entries.push({
      ...headers,
      value: bytes.slice(Math.min(headersEnd + headerEnd.length, next.at), next.at),
    });
    line = next;
  }
  return entries;
}
