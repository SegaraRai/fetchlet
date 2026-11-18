// ClientRequest, request and get: an outgoing request that buffers its body
// and sends it with fetch when it ends. Redirects are returned, not
// followed, as Node does.

import { Buffer } from "../buffer/buffer.ts";
import { invalidArgType, nodeError } from "../errors/errors.ts";
import { Writable } from "../stream/stream.ts";
import { urlToHttpOptions } from "../url/file-url.ts";
import { URL } from "../url/whatwg.ts";
import { Agent } from "./agent.ts";
import { type HeaderValue, validateHeaderName, validateHeaderValue } from "./headers.ts";
import { IncomingMessage } from "./incoming-message.ts";

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
    defaults: {
      protocol: string;
      port: number;
    } = {
      protocol: "http:",
      port: 80,
    },
  ) {
    // Finishing the body must not destroy the request, which would abort its fetch.
    super({ autoDestroy: false });
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    let merged: RequestOptions;
    if (typeof input === "string") {
      merged = {
        ...urlToHttpOptions(new URL(input)),
        ...options,
      };
    } else if (input instanceof URL) {
      merged = {
        ...urlToHttpOptions(input),
        ...options,
      };
    } else if (input !== null && typeof input === "object") {
      merged = {
        ...input,
        ...options,
      };
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
    // eslint-disable-next-line no-control-regex -- Node rejects control characters and spaces in a path.
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
