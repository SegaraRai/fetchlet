// The Fetch handler behind the shared Rust HTTP integration contract.

// Just enough of ReadableStream, Request, Response and AbortSignal for the
// host bindings in a bare engine.
globalThis.ReadableStream = class {
  #source;
  #queue = [];
  #closed = false;
  #error = null;
  #controller = {
    enqueue: (chunk) => this.#queue.push(chunk),
    close: () => {
      this.#closed = true;
    },
    error: (error) => {
      this.#error = error;
    },
  };

  constructor(source = {}) {
    this.#source = source;
    source.start?.(this.#controller);
  }

  getReader() {
    return {
      read: async () => {
        while (this.#queue.length === 0 && !this.#closed && !this.#error) {
          await this.#source.pull(this.#controller);
        }
        if (this.#error) {
          throw this.#error;
        }
        return this.#queue.length > 0
          ? { done: false, value: this.#queue.shift() }
          : { done: true, value: undefined };
      },
    };
  }
};

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

const text = (value) => Array.from(value, (character) => character.charCodeAt(0));

// Read a streamed request body: "chunks:bytes", or the host error code.
async function count(body) {
  if (body === null || body instanceof Uint8Array) {
    const length = body?.byteLength ?? 0;
    return { status: 200, headers: [], body: text((length ? 1 : 0) + ":" + length) };
  }
  const reader = body.getReader();
  let chunks = 0;
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return { status: 200, headers: [], body: text(chunks + ":" + length) };
      }
      chunks += 1;
      length += value.byteLength;
    }
  } catch (error) {
    return { status: 422, headers: [], body: text(String(error.code)) };
  }
}

globalThis.fetchletExports = {
  async handle(request, context) {
    if (request.url.endsWith("/count")) {
      return count(request.body);
    }
    if (request.url.endsWith("/failure")) {
      throw new Error("provider-private-detail");
    }
    if (request.url.endsWith("/slow")) {
      // Waits for an in-process route that never answers.
      await fetch("https://fetchlet.internal/slow");
      return { status: 200, headers: [], body: [] };
    }
    if (request.url.endsWith("/caller")) {
      // The in-process API answers from the trusted Rust Context; the header
      // set here does not identify the caller.
      const response = await fetch("https://fetchlet.internal/caller", {
        headers: [["x-caller", "forged"]],
      });
      return { status: response.status, headers: [], body: Array.from(response.body) };
    }
    return {
      status: 201,
      headers: [
        ["set-cookie", "first=1"],
        ["set-cookie", "second=2"],
        ["x-url", request.url],
        ["x-method", request.method],
        ["x-request-header", String(request.headers.find(([name]) => name === "x-test")?.[1])],
        ["x-address", context?.clientAddress ?? "none"],
        ["x-tenant", context?.tenant ?? "none"],
      ],
      body: request.body ?? [],
    };
  },
};
