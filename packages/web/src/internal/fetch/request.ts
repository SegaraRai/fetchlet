import { runtime } from "../runtime/runtime";
import { byteString, dictionary, domString, exposeAttributes, usvString } from "../webidl/idl";
import { BodyImpl } from "./body";
import "../dom/abort";

const normalizedMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

const forbiddenMethods = new Set(["CONNECT", "TRACE", "TRACK"]);

// Web IDL enumerations used by RequestInit (Fetch Standard §5.4).
const enumerations = {
  referrerPolicy: [
    "",
    "no-referrer",
    "no-referrer-when-downgrade",
    "same-origin",
    "origin",
    "strict-origin",
    "origin-when-cross-origin",
    "strict-origin-when-cross-origin",
    "unsafe-url",
  ],
  mode: ["navigate", "same-origin", "no-cors", "cors"],
  credentials: ["omit", "same-origin", "include"],
  cache: ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"],
  redirect: ["follow", "error", "manual"],
  duplex: ["half"],
  priority: ["high", "low", "auto"],
};

function enumeration(member: keyof typeof enumerations, value: unknown): string {
  const text = domString(value);
  if (!enumerations[member].includes(text)) {
    throw new TypeError(`Invalid RequestInit ${member}: ${text}`);
  }
  return text;
}

function methodName(input: unknown): string {
  const method = byteString(input);
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method) || forbiddenMethods.has(method.toUpperCase())) {
    throw new TypeError("Invalid request method");
  }
  const upper = method.toUpperCase();
  return normalizedMethods.has(upper) ? upper : method;
}

/** Fetch's request signal is a DOM dependent signal of the init or input signal. */
function dependentSignal(parent: any) {
  if (parent === undefined || parent === null) {
    return new runtime.AbortController().signal;
  }
  if (!(parent instanceof runtime.AbortSignal)) {
    throw new TypeError("Expected AbortSignal");
  }
  return runtime.AbortSignal.any([parent]);
}

/**
 * The request's referrer as exposed by `Request.referrer`.
 *
 * This profile has no environment settings object, so there is no origin to
 * compare a URL referrer with; like other server runtimes, a parsed URL is kept.
 */
function referrerOf(value: unknown) {
  const text = usvString(value);
  if (text === "") {
    return "";
  }
  const url = new runtime.URL(text);
  return url.href === "about:client" ? "about:client" : url.href;
}

interface RequestState {
  url: string;
  method: string;
  signal: any;
  redirect: string;
  referrer: string;
  referrerPolicy: string;
  mode: string;
  credentials: string;
  cache: string;
  integrity: string;
  keepalive: boolean;
}

const states = new WeakMap<object, RequestState>();

function state(request: unknown): RequestState {
  const value = states.get(request as object);
  if (!value) {
    throw new TypeError("Illegal invocation");
  }
  return value;
}

class RequestImpl extends BodyImpl {
  constructor(input: any, init: any = {}) {
    if (arguments.length === 0) {
      throw new TypeError("Request requires an input");
    }
    init = dictionary(init);
    const old = input instanceof RequestImpl ? state(input) : null;
    const url = new runtime.URL(old?.url ?? usvString(input));
    if (url.username || url.password) {
      throw new TypeError("Request URL contains credentials");
    }

    // A non-empty init resets the fields a navigation or referrer would carry.
    const initialized = Object.keys(init).length > 0;
    let mode = old?.mode ?? "cors";
    if (initialized && mode === "navigate") {
      mode = "same-origin";
    }
    let referrer = initialized ? "about:client" : (old?.referrer ?? "about:client");
    let referrerPolicy = initialized ? "" : (old?.referrerPolicy ?? "");

    if (init.referrer !== undefined) {
      referrer = referrerOf(init.referrer);
    }
    if (init.referrerPolicy !== undefined) {
      referrerPolicy = enumeration("referrerPolicy", init.referrerPolicy);
    }
    if (init.mode !== undefined) {
      mode = enumeration("mode", init.mode);
      if (mode === "navigate") {
        throw new TypeError("Cannot construct a navigate request");
      }
    }
    const credentials =
      init.credentials !== undefined
        ? enumeration("credentials", init.credentials)
        : (old?.credentials ?? "same-origin");
    const cache =
      init.cache !== undefined ? enumeration("cache", init.cache) : (old?.cache ?? "default");
    if (cache === "only-if-cached" && mode !== "same-origin") {
      throw new TypeError("only-if-cached requires same-origin mode");
    }
    const redirect =
      init.redirect !== undefined
        ? enumeration("redirect", init.redirect)
        : (old?.redirect ?? "follow");
    const integrity =
      init.integrity !== undefined ? domString(init.integrity) : (old?.integrity ?? "");
    const keepalive =
      init.keepalive !== undefined ? Boolean(init.keepalive) : (old?.keepalive ?? false);
    if (init.priority !== undefined) {
      enumeration("priority", init.priority);
    }
    if (init.duplex !== undefined) {
      enumeration("duplex", init.duplex);
    }
    const method = init.method !== undefined ? methodName(init.method) : (old?.method ?? "GET");
    const signal = dependentSignal(init.signal === undefined ? old?.signal : init.signal);

    super(
      init.body ?? (old ? (input as RequestImpl).cloneStream() : undefined),
      init.headers ?? (old ? (input as RequestImpl).headers : undefined),
    );

    if (["GET", "HEAD"].includes(method) && this.hasBody()) {
      throw new TypeError("GET/HEAD body");
    }

    states.set(this, {
      url: url.href,
      method,
      signal,
      redirect,
      referrer,
      referrerPolicy,
      mode,
      credentials,
      cache,
      integrity,
      keepalive,
    });
  }

  get url() {
    return state(this).url;
  }

  get method() {
    return state(this).method;
  }

  get destination() {
    state(this);
    return "";
  }

  get referrer() {
    return state(this).referrer;
  }

  get referrerPolicy() {
    return state(this).referrerPolicy;
  }

  get mode() {
    return state(this).mode;
  }

  get credentials() {
    return state(this).credentials;
  }

  get cache() {
    return state(this).cache;
  }

  get redirect() {
    return state(this).redirect;
  }

  get integrity() {
    return state(this).integrity;
  }

  get keepalive() {
    return state(this).keepalive;
  }

  get isReloadNavigation() {
    state(this);
    return false;
  }

  get isHistoryNavigation() {
    state(this);
    return false;
  }

  get signal() {
    return state(this).signal;
  }

  get duplex() {
    state(this);
    return "half";
  }

  clone() {
    const current = state(this);
    const copy = new RequestImpl(current.url, {
      method: current.method,
      headers: this.headers,
      body: this.cloneStream(),
    });
    states.set(copy, {
      ...current,
      signal: dependentSignal(current.signal),
    });
    return copy;
  }
}

exposeAttributes(RequestImpl.prototype, [
  "url",
  "method",
  "destination",
  "referrer",
  "referrerPolicy",
  "mode",
  "credentials",
  "cache",
  "redirect",
  "integrity",
  "keepalive",
  "isReloadNavigation",
  "isHistoryNavigation",
  "signal",
  "duplex",
]);

Object.defineProperty(RequestImpl, "name", {
  value: "Request",
});

runtime.Request ??= RequestImpl;
