// Just enough of Request, Response and AbortSignal for the host fetch binding.
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

// Module state exists once per instance. The first call fixes the
// instance's name from the unique name the test passes.
let instance;
let calls = 0;

globalThis.fetchletExports = {
  instance: (name) => (instance ??= name),
  calls: () => ++calls,
  // Wait until the test opens the gate, then report the instance.
  async wait(name) {
    instance ??= name;
    await fetch("https://gate.test/");
    return instance;
  },
  // Send over the host's shared connection, then keep this instance busy.
  async fetchThenSpin(milliseconds) {
    await fetch("https://connection.test/");
    const end = Date.now() + milliseconds;
    while (Date.now() < end) {
      // A busy loop: no host step runs until it ends.
    }
    return null;
  },
  async fetchOnce() {
    await fetch("https://connection.test/");
    return null;
  },
  // Call the same application from a host fetch.
  async reenter() {
    try {
      await fetch("https://reenter.test/");
      return "served";
    } catch (error) {
      return String(error.code);
    }
  },
};
