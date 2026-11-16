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
  for (const timer of timers.values()) due = Math.min(due, timer.due);
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

let sequence = 0;
let cancelled = 0;

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
        if (index >= count) return { done: true, value: undefined };
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
        if (index++ === 0) return { done: false, value: bytes("ok;") };
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
