// Request bodies streaming to an outbound fetch. Just enough of Request,
// Response, ReadableStream and AbortSignal for the host fetch binding; the
// Web API profile's Request tells the bridge which bodies stream through
// __fetchletStreamsBody, which this stand-in answers for every body.

class Signal {
  aborted = false;
  throwIfAborted() {}
  addEventListener() {}
  removeEventListener() {}
}

/** ASCII text as bytes. */
function asciiBytes(text) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/** A stream of the given chunks, recording what its reader did. */
class ChunkStream {
  constructor(chunks, record) {
    this.chunks = chunks;
    this.record = record;
    this.locked = false;
  }

  getReader() {
    this.locked = true;
    const { chunks, record } = this;
    return {
      async read() {
        // Each chunk arrives in a later turn, as a real producer's would.
        await Promise.resolve();
        record.reads += 1;
        if (chunks.length === 0) {
          return { value: undefined, done: true };
        }
        const chunk = chunks.shift();
        if (chunk === "fail") {
          throw new Error("producer failed");
        }
        return { value: typeof chunk === "string" ? asciiBytes(chunk) : chunk, done: false };
      },
      cancel() {
        record.cancelled = true;
        return Promise.resolve();
      },
      releaseLock() {},
    };
  }
}

globalThis.Request = class {
  constructor(url, init = {}) {
    this.url = url;
    this.method = init.method ?? "GET";
    this.headers = [];
    this.body = init.body ?? null;
    this.redirect = init.redirect ?? "follow";
    this.signal = new Signal();
  }
};

globalThis.Response = class {
  constructor(body, init) {
    this.body = body;
    this.status = init.status;
  }
};

globalThis.ReadableStream ??= class {};

Object.defineProperty(globalThis, "__fetchletStreamsBody", {
  value: (request) => request.body instanceof ChunkStream,
});

let last = null;

globalThis.fetchletExports = {
  /** POST `chunks` as a stream to `url`: the status and body, or the rejection code. */
  async upload(url, chunks, redirect) {
    last = { reads: 0, cancelled: false };
    const body = new ChunkStream(chunks, last);
    try {
      const response = await fetch(url, { method: "POST", body, redirect });
      const text = response.body === null ? "" : String.fromCharCode(...response.body);
      return { status: response.status, text };
    } catch (error) {
      return { error: error.code ?? error.name };
    }
  },
  /** What the reader of the last upload did. */
  record() {
    return last;
  },
};
