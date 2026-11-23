// Sockets over the bridge's channel registry, as @fetchlet/web's connect()
// uses it, for TcpTransport.

const channels = globalThis.__fetchletChannels;

// ASCII only: the engines run this without the Web API profile.
const text = (pieces) => String.fromCharCode(...pieces.flat());
const ascii = (string) => Uint8Array.from(string, (character) => character.charCodeAt(0));

function connect(hostname, port, secureTransport) {
  const record = {
    messages: [],
    opened: false,
    secured: false,
    ended: false,
    refused: null,
    close: null,
  };
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
      secure() {
        record.secured = true;
        notify();
      },
      message(data) {
        record.messages.push(Array.from(data));
        notify();
      },
      end() {
        record.ended = true;
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

const received = (record) => record.messages.flat().length;

globalThis.fetchletExports = {
  /**
   * Write `message`, then read until the server closes or `expected` bytes
   * arrive, closing then.
   */
  async exchange(hostname, port, secureTransport, message, expected) {
    const record = connect(hostname, port, secureTransport);
    await until(record, () => record.opened || record.refused !== null);
    if (record.refused !== null) {
      return { refused: record.refused };
    }
    await channels.write(record.id, ascii(message));
    await until(
      record,
      () => record.close !== null || record.ended || received(record) >= expected,
    );
    if (record.close === null) {
      // The server's bytes ended: end the writes too, as a socket that is
      // not half-open does, and the socket closes normally.
      if (record.ended) {
        channels.endWrites(record.id);
      } else {
        channels.close(record.id, 1000, "");
      }
      await until(record, () => record.close !== null);
    }
    return { received: text(record.messages), close: record.close };
  },
  /**
   * Write `message` and end the writes; read until the server's bytes end
   * and the socket closes.
   */
  async halfClose(hostname, port, message) {
    const record = connect(hostname, port, "off");
    await until(record, () => record.opened);
    await channels.write(record.id, ascii(message));
    channels.endWrites(record.id);
    await until(record, () => record.close !== null);
    return { received: text(record.messages), ended: record.ended, close: record.close };
  },
  /**
   * Ask a STARTTLS server to upgrade in plain text, switch to TLS once it
   * agrees, then exchange `message` over TLS.
   */
  async startTls(hostname, port, message, expected) {
    const record = connect(hostname, port, "starttls");
    await until(record, () => record.opened || record.refused !== null);
    if (record.refused !== null) {
      return { refused: record.refused };
    }
    await channels.write(record.id, ascii("STARTTLS\n"));
    await until(record, () => record.close !== null || received(record) >= 3);
    const greeting = text(record.messages);
    record.messages = [];
    if (record.close !== null) {
      return { greeting, close: record.close };
    }
    channels.startTls(record.id);
    await until(record, () => record.secured || record.close !== null);
    if (!record.secured) {
      return { greeting, close: record.close };
    }
    await channels.write(record.id, ascii(message));
    await until(record, () => record.close !== null || received(record) >= expected);
    channels.close(record.id, 1000, "");
    await until(record, () => record.close !== null);
    return { greeting, received: text(record.messages), close: record.close };
  },
  /** Whether startTls throws on a socket that did not ask for it. */
  async startTlsRefused(hostname, port) {
    const record = connect(hostname, port, "off");
    await until(record, () => record.opened);
    try {
      channels.startTls(record.id);
      return "started";
    } catch (error) {
      return error.code;
    } finally {
      channels.close(record.id, 1000, "");
    }
  },
};
