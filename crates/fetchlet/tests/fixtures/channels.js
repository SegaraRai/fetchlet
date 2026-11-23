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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Channels of env bindings over the bridge's channel registry, as
// @fetchlet/web's views use it.
const channels = globalThis.__fetchletChannels;

/** Open `service` and record what arrives. */
function open(service, options) {
  const record = { messages: [], opened: false, refused: null, close: null };
  let wake = () => {};
  record.changed = () =>
    new Promise((resolve) => {
      wake = resolve;
    });
  const notify = () => wake();
  record.id = channels.open(service, options, {
    open() {
      record.opened = true;
      notify();
    },
    message(data) {
      record.messages.push(typeof data === "string" ? data : Array.from(data));
      notify();
    },
    close(code, reason) {
      record.close = { code, reason };
      notify();
    },
    refused(message) {
      record.refused = message;
      notify();
    },
  });
  return record;
}

async function until(record, done) {
  while (!done()) {
    await record.changed();
  }
}

globalThis.fetchletExports = {
  async echo(messages) {
    const record = open("ECHO", { greeting: "hi" });
    await until(record, () => record.opened);
    for (const message of messages) {
      channels.send(record.id, message);
    }
    channels.send(record.id, new Uint8Array([1, 2, 3]));
    await until(record, () => record.messages.length === messages.length + 2);
    channels.close(record.id, 1000, "done");
    await until(record, () => record.close !== null);
    return { messages: record.messages, close: record.close };
  },
  async split(messages) {
    const record = open("SPLIT");
    await until(record, () => record.opened);
    for (const message of messages) {
      channels.send(record.id, message);
    }
    await until(record, () => record.messages.length === messages.length);
    channels.close(record.id, 1000, "done");
    await until(record, () => record.close !== null);
    return { messages: record.messages, close: record.close };
  },
  async drain(service) {
    const record = open(service);
    await until(record, () => record.close !== null);
    return { received: record.messages.length, close: record.close };
  },
  async refused() {
    const record = open("REFUSE");
    await until(record, () => record.refused !== null);
    return { refused: record.refused, opened: record.opened };
  },
  unknown() {
    try {
      open("NOPE");
      return "opened";
    } catch (error) {
      return error.code;
    }
  },
  limited() {
    const codes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        open("HOLD");
        codes.push("ok");
      } catch (error) {
        codes.push(error.code);
      }
    }
    return codes;
  },
  async leave() {
    const record = open("HOLD");
    await until(record, () => record.opened);
    channels.send(record.id, "left open");
    // Returned without closing: the channel ends with the invocation.
    return "returned";
  },
  async background() {
    const record = open("HOLD");
    await until(record, () => record.opened);
    fetchlet.waitUntil(
      (async () => {
        await sleep(20);
        channels.send(record.id, "from background");
      })(),
    );
    return "returned";
  },
  async write(size) {
    const record = open("ECHO");
    const bytes = new Uint8Array(size).fill(7);
    await until(record, () => record.opened);
    await channels.write(record.id, bytes);
    let received = 0;
    // The greeting, then echoed pieces of the write.
    await until(record, () => {
      received = record.messages.slice(1).reduce((total, piece) => total + piece.length, 0);
      return received === size;
    });
    channels.close(record.id, 1000, "");
    await until(record, () => record.close !== null);
    return { received, pieces: record.messages.length - 1 };
  },
  async abandonedWrite(size) {
    const record = open("DROP");
    await until(record, () => record.opened);
    let outcome;
    try {
      await channels.write(record.id, new Uint8Array(size));
      outcome = "written";
    } catch (error) {
      outcome = error.message;
    }
    await until(record, () => record.close !== null);
    return { outcome, close: record.close };
  },
  async paused(resume) {
    const record = open("FLOOD");
    channels.pause(record.id, true);
    await sleep(50);
    const whilePaused = record.messages.length;
    if (!resume) {
      return { whilePaused };
    }
    channels.pause(record.id, false);
    await until(record, () => record.close !== null);
    return { whilePaused, received: record.messages.length, close: record.close };
  },
  env() {
    try {
      fetchlet.env.ECHO.connect();
      return "connected";
    } catch (error) {
      return String(error.message);
    }
  },
};
