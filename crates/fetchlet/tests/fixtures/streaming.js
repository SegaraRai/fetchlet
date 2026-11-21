// Minimal timer hooks with the contract the Web API profile installs: the
// engine loop runs due timers, and the invocation clears them when it ends.
let nextTimer = 1;
const timers = new Map();
globalThis.setTimeout = (callback, delay = 0) => {
  const id = nextTimer++;
  timers.set(id, {
    due: Date.now() + Math.max(0, Number(delay) || 0),
    callback,
  });
  return id;
};
globalThis.clearTimeout = (id) => {
  timers.delete(id);
};
globalThis.__fetchletClearTimers = () => timers.clear();
globalThis.__fetchletTimerDelay = () => {
  let due = Infinity;
  for (const timer of timers.values()) {
    due = Math.min(due, timer.due);
  }
  return Number.isFinite(due) ? Math.max(0, due - Date.now()) : -1;
};
globalThis.__fetchletRunNextTimer = () => {
  const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
  if (next && next[1].due <= Date.now()) {
    timers.delete(next[0]);
    next[1].callback();
    return true;
  }
  return false;
};

// Just enough of a ReadableStream for host bodies: the bridge's underlying
// source pulls one chunk per read.
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
      this.#error = { error };
    },
  };

  constructor(source = {}) {
    this.#source = source;
    source.start?.(this.#controller);
  }

  getReader() {
    return {
      read: async () => {
        while (this.#queue.length === 0 && !this.#closed) {
          if (this.#error) {
            throw this.#error.error;
          }
          await this.#source.pull(this.#controller);
        }
        if (this.#error) {
          throw this.#error.error;
        }
        return this.#queue.length > 0
          ? { done: false, value: this.#queue.shift() }
          : { done: true, value: undefined };
      },
      cancel: async (reason) => {
        this.#closed = true;
        this.#queue.length = 0;
        await this.#source.cancel?.(reason);
      },
      releaseLock() {},
    };
  }
};

// Just enough of Request, Response and AbortSignal for the host fetch binding.
class Signal {
  #listeners = new Set();
  aborted = false;
  reason = undefined;

  throwIfAborted() {
    if (this.aborted) {
      throw this.reason;
    }
  }

  addEventListener(_type, listener) {
    this.#listeners.add(listener);
  }

  removeEventListener(_type, listener) {
    this.#listeners.delete(listener);
  }

  abort(reason) {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.reason = reason;
    for (const listener of Array.from(this.#listeners)) {
      listener();
    }
  }
}

// The bridge gives each Fetch invocation's request a signal from this.
globalThis.AbortController = class {
  signal = new Signal();

  abort(reason = new Error("aborted")) {
    this.signal.abort(reason);
  }
};

globalThis.Request = class {
  constructor(url, init = {}) {
    this.url = url;
    this.method = init.method ?? "GET";
    this.headers = [];
    this.body = null;
    this.redirect = "follow";
    this.signal = init.signal ?? new Signal();
  }
};

globalThis.Response = class {
  constructor(body, init) {
    this.body = body;
    this.status = init.status;
  }
};

let sequence = 0;
let cancelled = 0;
// Calls whose result came after a delay, whether or not the caller waited.
let finished = 0;
// Requests whose signal aborted.
let aborts = 0;

/** Resolves when `signal` aborts, or after two seconds. */
function aborted(signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
let backgroundDone = 0;
let backgroundBytes = 0;

// waitUntil needs an invocation; module evaluation has none.
let topLevelWaitUntil = "accepted";
try {
  fetchlet.waitUntil(Promise.resolve());
} catch (error) {
  topLevelWaitUntil = error.code;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const bytes = (text) => new Uint8Array(Array.from(text, (character) => character.charCodeAt(0)));

// Just enough of a ReadableStream for the host registry: getReader().read() / cancel().
function source(read) {
  return {
    getReader() {
      return {
        read,
        cancel: async () => {
          cancelled += 1;
        },
      };
    },
  };
}

// The bare engine has no URL: parse "https://host/path?name=value&...".
function parse(url) {
  const [location, query = ""] = url.split("?");
  const path = location.slice(location.indexOf("/", location.indexOf("//") + 2));
  const parameters = Object.fromEntries(
    query
      .split("&")
      .filter(Boolean)
      .map((pair) => pair.split("=")),
  );
  return { path, parameters };
}

function routes(url) {
  const { path, parameters } = parse(url);
  const count = Number(parameters.count ?? 3);
  const wait = Number(parameters.wait ?? 20);
  let index = 0;
  switch (path) {
    case "/ticks":
      return source(async () => {
        if (index >= count) {
          return { done: true, value: undefined };
        }
        await delay(wait);
        return { done: false, value: bytes(`tick-${index++};`) };
      });
    case "/forever":
      return source(async () => {
        await delay(wait);
        return { done: false, value: bytes(`tick-${index++};`) };
      });
    case "/pending":
      return source(() =>
        index++ === 0
          ? Promise.resolve({ done: false, value: bytes("start;") })
          : new Promise(() => {}),
      );
    case "/large":
      return source(async () =>
        index++ < count
          ? { done: false, value: new Uint8Array(40000).fill(97) }
          : { done: true, value: undefined },
      );
    case "/burst":
      return source(async () => ({
        done: false,
        value: new Uint8Array(40000).fill(98),
      }));
    case "/error":
      return source(async () => {
        if (index++ === 0) {
          return { done: false, value: bytes("ok;") };
        }
        await delay(wait);
        throw new Error("stream failure");
      });
    default:
      return null;
  }
}

globalThis.fetchletExports = {
  sequence: () => ++sequence,
  cancelled: () => cancelled,
  finished: () => finished,
  aborts: () => aborts,
  async slowCall() {
    await delay(150);
    return ++finished;
  },
  backgroundDone: () => backgroundDone,
  backgroundBytes: () => backgroundBytes,
  topLevelWaitUntil: () => topLevelWaitUntil,
  pendingTimers: () => timers.size,
  openBodies: () => globalThis.__fetchletResponseBodies.openCount(),
  // Try to read a body by a guessed id from a later invocation.
  async probe(id) {
    try {
      return (await globalThis.__fetchletResponseBodies.pull(id, false)).chunk.length;
    } catch {
      return null;
    }
  },
  async handle(request) {
    const bodies = globalThis.__fetchletResponseBodies;
    request.signal?.addEventListener("abort", () => {
      aborts += 1;
    });
    if (request.url.endsWith("/until-abort-head")) {
      // The head waits for the client to leave.
      const left = await aborted(request.signal);
      return { status: 200, headers: [], body: bytes(String(left)) };
    }
    if (request.url.endsWith("/until-abort-body")) {
      // The second read waits for the client to leave, then ends the body.
      let index = 0;
      const id = bodies.register(
        source(async () => {
          if (index++ === 0) {
            return { done: false, value: bytes("start;") };
          }
          await aborted(request.signal);
          return { done: true, value: undefined };
        }),
      );
      const initial = await bodies.pull(id, false);
      return { status: 200, headers: [], body: initial.chunk, stream: id };
    }
    if (request.url.endsWith("/slow-head")) {
      // The head comes after a delay.
      await delay(150);
      finished += 1;
      return { status: 200, headers: [], body: bytes("late") };
    }
    if (request.url.endsWith("/withheld")) {
      // Register a body, start a timer, and answer without handing the body over.
      const id = bodies.register(routes("https://stream.test/forever?wait=10"));
      setTimeout(() => {}, 1000);
      return {
        status: 200,
        headers: [["x-body", String(id)]],
        body: [],
      };
    }
    if (request.url.endsWith("/echo")) {
      // Forward request body chunks as the host delivers them.
      const id = bodies.register(request.body);
      const initial = await bodies.pull(id, false);
      return {
        status: 200,
        headers: [],
        body: initial.chunk,
        ...(initial.done ? {} : { stream: id }),
      };
    }
    if (request.url.endsWith("/count")) {
      // Read the whole request body: "chunks:bytes", or the error code.
      const reader = request.body.getReader();
      let chunks = 0;
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks += 1;
          length += value.byteLength;
        }
      } catch (error) {
        return { status: 500, headers: [], body: bytes(String(error.code)) };
      }
      return { status: 200, headers: [], body: bytes(chunks + ":" + length) };
    }
    if (request.url.endsWith("/proxy")) {
      // Hand the upstream body to the host as this response's body.
      const upstream = await fetch("https://upstream.test/body");
      const id = bodies.register(upstream.body);
      const initial = await bodies.pull(id, false);
      return {
        status: upstream.status,
        headers: [],
        body: initial.chunk,
        ...(initial.done ? {} : { stream: id }),
      };
    }
    if (request.url.endsWith("/abort-upstream")) {
      // Abort the fetch after its first chunk: "<chunk>|<error message>".
      const signal = new Signal();
      const upstream = await fetch("https://upstream.test/body", { signal });
      const reader = upstream.body.getReader();
      const first = await reader.read();
      signal.abort(new Error("stopped"));
      let outcome;
      try {
        outcome = String((await reader.read()).done);
      } catch (error) {
        outcome = error.message;
      }
      const text = String.fromCharCode(...first.value) + "|" + outcome;
      return { status: 200, headers: [], body: bytes(text) };
    }
    if (request.url.includes("/background")) {
      const { path, parameters } = parse(request.url);
      const finish = () => {
        backgroundDone += 1;
      };
      let registered = 0;
      let refusal = "none";
      try {
        switch (path) {
          case "/background":
            // A timer the invocation keeps for its background work.
            fetchlet.waitUntil(delay(Number(parameters.wait ?? 20)).then(finish));
            registered += 1;
            break;
          case "/background-forever":
            fetchlet.waitUntil(new Promise(() => {}));
            registered += 1;
            break;
          case "/background-rejected":
            fetchlet.waitUntil(Promise.reject(new Error("ignored")));
            fetchlet.waitUntil(delay(5).then(finish));
            registered += 2;
            break;
          case "/background-many":
            for (let index = 0; index < Number(parameters.count); index += 1) {
              fetchlet.waitUntil(delay(5).then(finish));
              registered += 1;
            }
            break;
          case "/background-upstream":
            // Read an upstream body after the response was sent.
            fetchlet.waitUntil(
              fetch("https://upstream.test/body").then(async (upstream) => {
                const reader = upstream.body.getReader();
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) {
                    break;
                  }
                  backgroundBytes += value.byteLength;
                }
                finish();
              }),
            );
            registered += 1;
            break;
          case "/background-stream": {
            fetchlet.waitUntil(delay(5).then(finish));
            registered += 1;
            const id = bodies.register(routes("https://stream.test/ticks?count=2&wait=5"));
            const initial = await bodies.pull(id, false);
            return {
              status: 200,
              headers: [],
              body: initial.chunk,
              ...(initial.done ? {} : { stream: id }),
            };
          }
        }
      } catch (error) {
        refusal = error.code;
      }
      return {
        status: 202,
        headers: [],
        body: bytes(registered + ":" + refusal),
      };
    }
    if (request.url.endsWith("/ignore")) {
      return { status: 200, headers: [], body: [] };
    }
    const body = routes(request.url);
    if (body === null || !bodies.streaming()) {
      return {
        status: 404,
        headers: [],
        body: [],
      };
    }
    const id = bodies.register(body);
    const initial = await bodies.pull(id, false);
    return {
      status: 200,
      headers: [["content-type", "text/plain"]],
      body: initial.chunk,
      ...(initial.done ? {} : { stream: id }),
    };
  },
};
