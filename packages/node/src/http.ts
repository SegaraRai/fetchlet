// node:http client requests over the profile's fetch: request and get
// return a ClientRequest that buffers its body and sends it on end, and
// emit an IncomingMessage whose body streams from the response. Redirects
// are returned, not followed, as Node does. Servers are not provided; an
// artifact serves through its fetch handler.

import { Buffer } from "./buffer.ts";
import { invalidArgType, invalidArgValue, nodeError } from "./errors.ts";
import { Readable, Writable } from "./stream.ts";
import { URL, urlToHttpOptions } from "./url.ts";

type HeaderValue = string | number | string[];

export const METHODS = [
  "ACL",
  "BIND",
  "CHECKOUT",
  "CONNECT",
  "COPY",
  "DELETE",
  "GET",
  "HEAD",
  "LINK",
  "LOCK",
  "M-SEARCH",
  "MERGE",
  "MKACTIVITY",
  "MKCALENDAR",
  "MKCOL",
  "MOVE",
  "NOTIFY",
  "OPTIONS",
  "PATCH",
  "POST",
  "PROPFIND",
  "PROPPATCH",
  "PURGE",
  "PUT",
  "QUERY",
  "REBIND",
  "REPORT",
  "SEARCH",
  "SOURCE",
  "SUBSCRIBE",
  "TRACE",
  "UNBIND",
  "UNLINK",
  "UNLOCK",
  "UNSUBSCRIBE",
];

export const STATUS_CODES: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  509: "Bandwidth Limit Exceeded",
  510: "Not Extended",
  511: "Network Authentication Required",
};

// Node's default limit on the size of received headers, in bytes.
export const maxHeaderSize = 16_384;

const tokenPattern = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const invalidValuePattern = /[^\t\x20-\x7e\x80-\xff]/;

export function validateHeaderName(name: string, label = "Header name") {
  if (typeof name !== "string" || !name || !tokenPattern.test(name)) {
    throw nodeError(
      TypeError,
      "ERR_INVALID_HTTP_TOKEN",
      `${label} must be a valid HTTP token ["${String(name)}"]`,
    );
  }
}

export function validateHeaderValue(name: string, value: unknown) {
  if (value === undefined) {
    throw nodeError(
      TypeError,
      "ERR_HTTP_INVALID_HEADER_VALUE",
      `Invalid value "${String(value)}" for header "${name}"`,
    );
  }
  if (invalidValuePattern.test(String(value))) {
    throw nodeError(
      TypeError,
      "ERR_INVALID_CHAR",
      `Invalid character in header content ["${name}"]`,
    );
  }
}

export class Agent {
  readonly options: Record<string, unknown>;
  readonly defaultPort: number;
  readonly protocol: string;
  maxSockets = Infinity;
  maxFreeSockets = 256;
  keepAlive: boolean;

  constructor(options: Record<string, unknown> = {}, defaults = { port: 80, protocol: "http:" }) {
    this.options = { path: null, ...options };
    this.defaultPort = (options.defaultPort as number | undefined) ?? defaults.port;
    this.protocol = (options.protocol as string | undefined) ?? defaults.protocol;
    this.keepAlive = Boolean(options.keepAlive);
  }

  destroy() {}
}

export const globalAgent = new Agent();

/** A response: a Readable of the body with Node's view of the status and headers. */
export class IncomingMessage extends Readable {
  httpVersion = "1.1";
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  complete = false;
  statusCode: number | undefined;
  statusMessage: string | undefined;
  headers: Record<string, string | string[]> = {};
  headersDistinct: Record<string, string[]> = {};
  rawHeaders: string[] = [];
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
  url = "";
  method: string | null = null;
  socket = null;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor(response?: Response) {
    super();
    if (!response) {
      return;
    }
    this.statusCode = response.status;
    this.statusMessage = response.statusText || STATUS_CODES[response.status] || "";
    const setCookies = response.headers.getSetCookie?.() ?? [];
    response.headers.forEach((value, name) => {
      if (name === "set-cookie") {
        return;
      }
      this.headers[name] = value;
      this.headersDistinct[name] = [value];
      this.rawHeaders.push(name, value);
    });
    if (setCookies.length > 0) {
      this.headers["set-cookie"] = setCookies;
      this.headersDistinct["set-cookie"] = setCookies;
      for (const cookie of setCookies) {
        this.rawHeaders.push("set-cookie", cookie);
      }
    }
    this.#reader = response.body?.getReader();
  }

  _read() {
    const reader = this.#reader;
    if (!reader) {
      this.complete = true;
      this.push(null);
      return;
    }
    reader.read().then(
      ({ done, value }) => {
        if (done) {
          this.complete = true;
          this.push(null);
        } else {
          this.push(Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
        }
      },
      (error: Error) => this.destroy(error),
    );
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (this.#reader && !this.complete) {
      this.#reader.cancel(error ?? undefined).catch(() => {});
    }
    callback(error);
  }

  setTimeout(_msecs: number, callback?: () => void): this {
    if (callback) {
      this.once("timeout", callback);
    }
    return this;
  }
}

export interface RequestOptions {
  protocol?: string | null;
  host?: string | null;
  hostname?: string | null;
  port?: number | string | null;
  defaultPort?: number;
  path?: string | null;
  method?: string;
  headers?: Record<string, HeaderValue> | string[];
  auth?: string | null;
  agent?: Agent | boolean;
  timeout?: number;
  signal?: AbortSignal;
  setHost?: boolean;
  [option: string]: unknown;
}

/** An outgoing request; its body is sent when it ends. */
export class ClientRequest extends Writable {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly protocol: string;
  readonly agent: Agent | undefined;
  aborted = false;
  reusedSocket = false;
  maxHeadersCount: number | null = null;
  socket = null;
  #headers = new Map<string, [string, HeaderValue]>();
  #chunks: Uint8Array[] = [];
  #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sent = false;
  #url: string;

  constructor(
    input: string | URL | RequestOptions,
    options?: RequestOptions | ((response: IncomingMessage) => void),
    callback?: (response: IncomingMessage) => void,
    defaults: { protocol: string; port: number } = { protocol: "http:", port: 80 },
  ) {
    // Finishing the body must not destroy the request, which would abort its fetch.
    super({ autoDestroy: false });
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    let merged: RequestOptions;
    if (typeof input === "string") {
      merged = { ...urlToHttpOptions(new URL(input)), ...options };
    } else if (input instanceof URL) {
      merged = { ...urlToHttpOptions(input), ...options };
    } else if (input !== null && typeof input === "object") {
      merged = { ...input, ...options };
    } else {
      throw invalidArgType("options", "of type object or string or an instance of URL", input);
    }
    const agent = merged.agent instanceof Agent ? merged.agent : undefined;
    const protocol = merged.protocol ?? agent?.protocol ?? defaults.protocol;
    if (protocol !== defaults.protocol) {
      throw nodeError(
        TypeError,
        "ERR_INVALID_PROTOCOL",
        `Protocol "${protocol}" not supported. Expected "${defaults.protocol}"`,
      );
    }
    const method = (merged.method ?? "GET").toUpperCase();
    validateHeaderName(method, "Method");
    const hostname = merged.hostname ?? merged.host?.replace(/:\d+$/, "") ?? "localhost";
    const port = merged.port ?? merged.defaultPort ?? agent?.defaultPort ?? defaults.port;
    const path = merged.path ?? "/";
    if (/[\u0000- ]/.test(path)) {
      throw nodeError(
        TypeError,
        "ERR_UNESCAPED_CHARACTERS",
        "Request path contains unescaped characters",
      );
    }
    this.method = method;
    this.path = path;
    this.host = hostname;
    this.protocol = protocol;
    this.agent = agent;
    const authority = hostname.includes(":") ? `[${hostname}]` : hostname;
    const portSuffix = Number(port) === defaults.port ? "" : `:${port}`;
    this.#url = `${protocol}//${authority}${portSuffix}${path}`;
    const headers = merged.headers;
    if (Array.isArray(headers)) {
      for (let index = 0; index + 1 < headers.length; index += 2) {
        this.setHeader(headers[index], headers[index + 1]);
      }
    } else if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) {
          this.setHeader(name, value);
        }
      }
    }
    if (merged.auth && !this.hasHeader("authorization")) {
      this.setHeader("Authorization", `Basic ${Buffer.from(merged.auth).toString("base64")}`);
    }
    if (merged.signal) {
      const signal = merged.signal;
      if (signal.aborted) {
        queueMicrotask(() => this.destroy(abortError(signal.reason)));
      } else {
        signal.addEventListener("abort", () => this.destroy(abortError(signal.reason)), {
          once: true,
        });
      }
    }
    if (merged.timeout !== undefined) {
      this.setTimeout(merged.timeout);
    }
    if (callback) {
      this.once("response", callback);
    }
  }

  setHeader(name: string, value: HeaderValue): this {
    if (this.#sent) {
      throw nodeError(
        Error,
        "ERR_HTTP_HEADERS_SENT",
        "Cannot set headers after they are sent to the client",
      );
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);
    this.#headers.set(name.toLowerCase(), [name, value]);
    return this;
  }

  getHeader(name: string): HeaderValue | undefined {
    return this.#headers.get(name.toLowerCase())?.[1];
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase());
  }

  removeHeader(name: string) {
    this.#headers.delete(name.toLowerCase());
  }

  getHeaders(): Record<string, HeaderValue> {
    const headers = Object.create(null) as Record<string, HeaderValue>;
    for (const [key, [, value]] of this.#headers) {
      headers[key] = value;
    }
    return headers;
  }

  getHeaderNames(): string[] {
    return [...this.#headers.keys()];
  }

  getRawHeaderNames(): string[] {
    return [...this.#headers.values()].map(([name]) => name);
  }

  get headersSent(): boolean {
    return this.#sent;
  }

  flushHeaders() {}

  setNoDelay(_noDelay?: boolean) {}

  setSocketKeepAlive(_enable?: boolean, _initialDelay?: number) {}

  setTimeout(msecs: number, callback?: () => void): this {
    if (callback) {
      this.once("timeout", callback);
    }
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (msecs > 0) {
      this.#timer = setTimeout(() => this.emit("timeout"), msecs);
    }
    return this;
  }

  abort() {
    if (!this.aborted) {
      this.aborted = true;
      queueMicrotask(() => this.emit("abort"));
      this.destroy();
    }
  }

  _write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void) {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk, encoding as "utf8") : (chunk as Uint8Array);
    this.#chunks.push(new Uint8Array(bytes).slice());
    callback();
  }

  _final(callback: (error?: Error | null) => void) {
    this.#send();
    callback();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }
    this.#controller.abort(error ?? abortError());
    callback(error);
  }

  #send() {
    this.#sent = true;
    const headers = new Headers();
    for (const [, [name, value]] of this.#headers) {
      for (const item of Array.isArray(value) ? value : [value]) {
        headers.append(name, String(item));
      }
    }
    const body =
      this.method === "GET" || this.method === "HEAD" || this.#chunks.length === 0
        ? undefined
        : Buffer.concat(this.#chunks);
    this.#chunks = [];
    fetch(this.#url, {
      method: this.method,
      headers,
      body: body as BodyInit | undefined,
      redirect: "manual",
      signal: this.#controller.signal,
    }).then(
      (response) => {
        if (this.#timer !== undefined) {
          clearTimeout(this.#timer);
          this.#timer = undefined;
        }
        const message = new IncomingMessage(response);
        message.method = this.method;
        if (!this.emit("response", message)) {
          // Without a listener the body is consumed, as Node does.
          message.resume();
        }
        this.emit("close");
      },
      (error: Error) => {
        if (!this.destroyed) {
          this.destroy(connectionError(error));
        }
      },
    );
  }
}

function abortError(reason?: unknown): Error {
  const error = nodeError(Error, "ABORT_ERR", "The operation was aborted") as Error & {
    cause?: unknown;
  };
  error.name = "AbortError";
  if (reason !== undefined) {
    error.cause = reason;
  }
  return error;
}

function connectionError(cause: Error): Error {
  const error = nodeError(Error, "ECONNREFUSED", cause.message || "fetch failed") as Error & {
    cause?: unknown;
  };
  error.cause = cause;
  return error;
}

export function request(
  input: string | URL | RequestOptions,
  options?: RequestOptions | ((response: IncomingMessage) => void),
  callback?: (response: IncomingMessage) => void,
): ClientRequest {
  return new ClientRequest(input, options, callback);
}

export function get(
  input: string | URL | RequestOptions,
  options?: RequestOptions | ((response: IncomingMessage) => void),
  callback?: (response: IncomingMessage) => void,
): ClientRequest {
  const outgoing = request(input, options, callback);
  outgoing.end();
  return outgoing;
}

const serverUnavailable = (name: string) => () => {
  throw nodeError(
    Error,
    "ERR_METHOD_NOT_IMPLEMENTED",
    `http.${name} is not available in fetchlet; an artifact serves through its fetch handler`,
  );
};

export const createServer = serverUnavailable("createServer");
export const Server = serverUnavailable("Server");
export const ServerResponse = serverUnavailable("ServerResponse");
export const OutgoingMessage = Writable;

export function setMaxIdleHTTPParsers(max: number) {
  if (!Number.isInteger(max) || max < 1) {
    throw invalidArgValue("max", max);
  }
}

export default {
  METHODS,
  STATUS_CODES,
  maxHeaderSize,
  Agent,
  globalAgent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  Server,
  ServerResponse,
  createServer,
  request,
  get,
  validateHeaderName,
  validateHeaderValue,
  setMaxIdleHTTPParsers,
};
