// Client WebSockets over the bridge's channel registry, as @fetchlet/web's
// WebSocket uses it: each export opens a URL and records what arrives.

const channels = globalThis.__fetchletChannels;

/** Open `url` with `protocols` and record what arrives. */
function open(url, protocols = []) {
  const record = {
    messages: [],
    accepted: null,
    opened: false,
    refused: null,
    close: null,
  };
  let wake = () => {};
  record.changed = () =>
    new Promise((resolve) => {
      wake = resolve;
    });
  const notify = () => wake();
  record.id = channels.websocket(
    { url, protocols },
    {
      open(accepted) {
        record.opened = true;
        record.accepted = accepted ?? null;
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
    },
  );
  return record;
}

async function until(record, done) {
  while (!done()) {
    await record.changed();
  }
}

globalThis.fetchletExports = {
  /** Send `message` as text and bytes, read both answers, then close. */
  async exchange(url, protocols, message) {
    const record = open(url, protocols);
    await until(record, () => record.opened || record.refused !== null);
    if (record.refused !== null) {
      return { refused: record.refused };
    }
    channels.send(record.id, message);
    channels.send(record.id, Uint8Array.of(1, 2, 3));
    await until(record, () => record.close !== null || record.messages.length >= 2);
    channels.close(record.id, 1000, "done");
    await until(record, () => record.close !== null);
    return { accepted: record.accepted, messages: record.messages, close: record.close };
  },
  /** Read until the server closes or the handshake fails. */
  async drain(url) {
    const record = open(url);
    await until(record, () => record.close !== null || record.refused !== null);
    return {
      opened: record.opened,
      messages: record.messages,
      close: record.close,
      refused: record.refused,
    };
  },
  /** Open and return without closing. */
  async leave(url) {
    const record = open(url);
    await until(record, () => record.opened);
    channels.send(record.id, "left open");
    return "returned";
  },
  /** The error code of an open the host refuses at once. */
  code(url, protocols = []) {
    try {
      open(url, protocols);
      return "opened";
    } catch (error) {
      return error.code;
    }
  },
};
