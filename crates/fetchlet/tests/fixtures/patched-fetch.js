// Just enough of Request and Response for the host fetch binding.
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
    this.redirect = "follow";
    this.signal = new Signal();
  }
};

globalThis.Response = class {
  constructor(body, init) {
    this.body = body;
    this.status = init.status;
  }
};

// Wrap the global fetch as Next.js-style frameworks do.
const original = globalThis.fetch;
let calls = 0;
globalThis.fetch = (input, init) => {
  calls += 1;
  return original(input, init);
};

globalThis.fetchletExports = {
  async patched() {
    const allowed = await fetch("https://allowed.test/");
    let denied = "sent";
    try {
      await fetch("https://denied.test/");
    } catch {
      denied = "rejected";
    }
    return { status: allowed.status, denied, calls };
  },
};
