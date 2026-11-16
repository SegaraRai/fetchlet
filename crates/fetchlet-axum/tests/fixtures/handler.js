// Just enough of a ReadableStream for streamed host request bodies.
globalThis.ReadableStream = class {
  #source;
  #queue = [];
  #closed = false;
  #controller = {
    enqueue: (chunk) => this.#queue.push(chunk),
    close: () => {
      this.#closed = true;
    },
  };

  constructor(source = {}) {
    this.#source = source;
  }

  getReader() {
    return {
      read: async () => {
        while (this.#queue.length === 0 && !this.#closed) {
          await this.#source.pull(this.#controller);
        }
        return this.#queue.length > 0
          ? { done: false, value: this.#queue.shift() }
          : { done: true, value: undefined };
      },
    };
  }
};

const text = (value) => Array.from(value, (character) => character.charCodeAt(0));

// Read a streamed body: "chunks:bytes", or the host error code.
async function count(body) {
  const reader = body.getReader();
  let chunks = 0;
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { status: 200, headers: [], body: text(chunks + ":" + length) };
      chunks += 1;
      length += value.byteLength;
    }
  } catch (error) {
    return { status: 422, headers: [], body: text(String(error.code)) };
  }
}

globalThis.fetchletExports = {
  handle(request, context) {
    if (request.url.endsWith("/count")) {
      return count(request.body);
    }
    if (request.url.endsWith("/failure")) {
      throw new Error("provider-private-detail");
    }
    return {
      status: 201,
      headers: [
        ["set-cookie", "first=1"],
        ["set-cookie", "second=2"],
        ["x-url", request.url],
        ["x-method", request.method],
        ["x-address", context.clientAddress ?? "none"],
        ["x-tenant", context.tenant ?? "none"],
      ],
      body: request.body ?? [],
    };
  },
};
