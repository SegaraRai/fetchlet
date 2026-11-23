// Sockets over the bridge's channel registry, as @fetchlet/web's connect()
// uses it: each export connects to an address and records what arrives.

const channels = globalThis.__fetchletChannels;

/** Connect to `hostname:port` and record what arrives. */
function connect(hostname, port, secureTransport = "off") {
  const record = { messages: [], opened: false, refused: null, close: null };
  let wake = () => {};
  record.changed = () =>
    new Promise((resolve) => {
      wake = resolve;
    });
  const notify = () => wake();
  record.id = channels.connect(
    { hostname, port, secureTransport },
    {
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
    },
  );
  return record;
}

async function until(record, done) {
  while (!done()) {
    await record.changed();
  }
}

// ASCII only: the engines run these without the Web API profile.
const text = (pieces) => String.fromCharCode(...pieces.flat());
const ascii = (string) => Uint8Array.from(string, (character) => character.charCodeAt(0));

globalThis.fetchletExports = {
  /** Write `message`, read until `expected` bytes arrive, then close. */
  async exchange(hostname, port, message, expected, secureTransport) {
    const record = connect(hostname, port, secureTransport);
    await until(record, () => record.opened || record.refused !== null);
    if (record.refused !== null) {
      return { refused: record.refused };
    }
    await channels.write(record.id, ascii(message));
    await until(record, () => record.close !== null || record.messages.flat().length >= expected);
    channels.close(record.id, 1000, "");
    await until(record, () => record.close !== null);
    return { received: text(record.messages), close: record.close };
  },
  /** Read until the peer closes. */
  async drain(hostname, port) {
    const record = connect(hostname, port);
    await until(record, () => record.close !== null || record.refused !== null);
    return { received: text(record.messages), close: record.close, refused: record.refused };
  },
  /** Connect and return without closing. */
  async leave(hostname, port) {
    const record = connect(hostname, port);
    await until(record, () => record.opened);
    channels.send(record.id, ascii("left open"));
    return "returned";
  },
  /** The error code of a connect the host refuses at once. */
  code(hostname, port, secureTransport) {
    try {
      connect(hostname, port, secureTransport);
      return "connected";
    } catch (error) {
      return error.code;
    }
  },
  /** Wait for a connect that fails after it starts. */
  async refused(hostname, port, secureTransport) {
    const record = connect(hostname, port, secureTransport);
    await until(record, () => record.opened || record.refused !== null);
    return { opened: record.opened, refused: record.refused };
  },
};
