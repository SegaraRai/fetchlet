// Just enough of ReadableStream, Request, Response and AbortSignal for host fetch.
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

async function bytes(body) {
  if (body === null || body instanceof Uint8Array) {
    return body ?? [];
  }
  const reader = body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return chunks.flatMap((chunk) => Array.from(chunk));
    }
    chunks.push(value);
  }
}

globalThis.fetchletExports = {
  // "/fetch?to=<url>": answer with the host response.
  async handle(request) {
    const target = decodeURIComponent(request.url.split("?to=")[1]);
    const response = await fetch(target, { headers: [["x-caller", "forged"]] });
    return { status: response.status, headers: [], body: await bytes(response.body) };
  },
};
