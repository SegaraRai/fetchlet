import { BodyImpl } from "./body";
import { byteString, dictionary, domString } from "./idl";
import { runtime } from "./runtime";

import "./abort";

const normalizedMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

const forbiddenMethods = new Set(["CONNECT", "TRACE", "TRACK"]);

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

class RequestImpl extends BodyImpl {
  url: string;
  method: string;
  signal: any;
  redirect: string;

  constructor(input: any, init: any = {}) {
    if (arguments.length === 0) {
      throw new TypeError("Request requires an input");
    }
    init = dictionary(init);
    const old = input instanceof RequestImpl ? input : null;
    const url = new runtime.URL(old?.url ?? domString(input));
    if (url.username || url.password) {
      throw new TypeError("Request URL contains credentials");
    }
    const method = methodName(init.method ?? old?.method ?? "GET");
    const redirect = domString(init.redirect ?? old?.redirect ?? "follow");
    if (!["follow", "error", "manual"].includes(redirect)) {
      throw new TypeError("Invalid redirect mode");
    }
    const signal = dependentSignal(init.signal === undefined ? old?.signal : init.signal);
    super(init.body ?? old?.cloneStream(), init.headers ?? old?.headers);
    this.url = url.href;
    this.method = method;
    this.signal = signal;
    this.redirect = redirect;
    if (["GET", "HEAD"].includes(this.method) && this.body) {
      throw new TypeError("GET/HEAD body");
    }
  }

  clone() {
    return new RequestImpl(this.url, {
      method: this.method,
      headers: this.headers,
      body: this.cloneStream(),
      signal: this.signal,
      redirect: this.redirect,
    });
  }
}

Object.defineProperty(RequestImpl, "name", { value: "Request" });

runtime.Request ??= RequestImpl;
