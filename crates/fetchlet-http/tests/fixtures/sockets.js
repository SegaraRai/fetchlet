// Sockets over the bridge's channel registry, as @fetchlet/web's connect()
// uses it, for TcpTransport.

const channels = globalThis.__fetchletChannels;

// ASCII only: the engines run this without the Web API profile.
const text = (pieces) => String.fromCharCode(...pieces.flat());
const ascii = (string) => Uint8Array.from(string, (character) => character.charCodeAt(0));

function connect(hostname, port, secureTransport) {
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
        record.messages.push(Array.from(data));
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
    await until(record, () => record.close !== null || record.messages.flat().length >= expected);
    if (record.close === null) {
      channels.close(record.id, 1000, "");
      await until(record, () => record.close !== null);
    }
    return { received: text(record.messages), close: record.close };
  },
};
