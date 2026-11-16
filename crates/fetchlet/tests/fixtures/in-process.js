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

const bytes = (text) => new Uint8Array(Array.from(text, (character) => character.charCodeAt(0)));

// Answer with the host response, or status 599 and the rejection code.
async function relay(send) {
  try {
    const response = await send();
    return { status: response.status, headers: [], body: response.body ?? new Uint8Array() };
  } catch (error) {
    return { status: 599, headers: [], body: bytes(String(error.code)) };
  }
}

globalThis.fetchletExports = {
  ping: () => "pong",
  // "/global?to=<url>" uses the global fetch, "/binding?to=<url>" the API binding.
  async handle(request) {
    const target = decodeURIComponent(request.url.split("?to=")[1]);
    // A header JavaScript controls; only the Rust Context identifies the caller.
    const init = { headers: [["x-caller", "forged"]] };
    if (request.url.includes("/binding?")) {
      return relay(() => fetchlet.env.API.fetch(target, init));
    }
    return relay(() => fetch(target, init));
  },
};
