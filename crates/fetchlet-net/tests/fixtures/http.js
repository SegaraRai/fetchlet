// Just enough of Request, Response, ReadableStream and AbortSignal for the
// host fetch binding, so the global fetch reaches HttpClient without the
// Web API profile. Response bodies stream, which this stand-in leaves
// unread; tests/http.rs reads bodies through the transport itself.
class Signal {
  aborted = false;
  throwIfAborted() {}
  addEventListener() {}
  removeEventListener() {}
}

globalThis.Request = class {
  constructor(url, init = {}) {
    this.url = url;
    this.method = init.method ?? "GET";
    this.headers = init.headers ?? [];
    this.body = null;
    this.redirect = "manual";
    this.signal = new Signal();
  }
};

globalThis.Response = class {
  constructor(body, init) {
    this.body = body;
    this.status = init.status;
    this.headers = init.headers;
  }
};

globalThis.ReadableStream ??= class {
  cancel() {
    return Promise.resolve();
  }
};

globalThis.fetchletExports = {
  /** Fetch `url` and answer with the status and echoed header, or the rejection code. */
  async send(url) {
    try {
      const response = await fetch(url, { headers: [["x-test", "from-js"]] });
      const echoed = response.headers.find(([name]) => name === "x-echo");
      return { status: response.status, echoed: echoed?.[1] ?? null };
    } catch (error) {
      return { refused: String(error.code) };
    }
  },
};
