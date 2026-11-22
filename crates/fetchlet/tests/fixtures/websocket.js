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

// A server WebSocket over the bridge's channel registry, as
// @fetchlet/web's upgradeWebSocket builds one.
const channels = globalThis.__fetchletChannels;

function header(request, name) {
  return request.headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
}

function accept(path) {
  // The listener runs once the channel exists.
  const socket = { id: 0 };
  const listener = {
    open() {
      if (path === "/greet") {
        channels.send(socket.id, "hello");
      }
    },
    message(data) {
      if (data === "later") {
        setTimeout(() => channels.send(socket.id, "timer"), 20);
      } else if (data === "big") {
        channels.send(socket.id, "x".repeat(64));
      } else if (data === "close") {
        channels.close(socket.id, 4000, "bye");
      } else if (data === "buffered") {
        channels.send(socket.id, String(channels.buffered(socket.id)));
      } else if (typeof data === "string") {
        channels.send(socket.id, `echo:${data}`);
      } else {
        channels.send(socket.id, data.reverse());
      }
    },
    close() {},
  };
  socket.id = channels.upgrade(listener);
  return socket.id;
}

globalThis.fetchletExports = {
  ping: () => "pong",
  handle(request) {
    const path = request.url.replace(/^[a-z]+:\/\/[^/]+/, "").split("?")[0];
    if (header(request, "upgrade") !== "websocket") {
      return { status: 200, headers: [], body: [] };
    }
    let id;
    try {
      id = accept(path);
    } catch (error) {
      return { status: 426, headers: [["x-error", String(error.code)]], body: [] };
    }
    if (path === "/decline") {
      // The socket is not returned; it ends with the invocation.
      return { status: 200, headers: [], body: [] };
    }
    return { status: 101, headers: [["sec-websocket-protocol", "chat"]], body: [], upgrade: id };
  },
};
