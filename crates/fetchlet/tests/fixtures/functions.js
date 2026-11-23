const DB = fetchlet.env.DB;

// Channels Rust returns, over the bridge's channel registry. The Web API
// profile builds channel objects with `__fetchletChannelViews.lend`; this
// stand-in records what arrives instead.
const channels = globalThis.__fetchletChannels;

const views = Object.freeze({
  lend(id) {
    const record = { id, messages: [], opened: false, close: null };
    let wake = () => {};
    record.changed = () =>
      new Promise((resolve) => {
        wake = resolve;
      });
    const notify = () => wake();
    channels.adopt(id, {
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
    });
    return record;
  },
});

Object.defineProperty(globalThis, "__fetchletChannelViews", {
  value: views,
  configurable: true,
});

async function until(record, done) {
  while (!done()) {
    await record.changed();
  }
}

/** A Uint8Array whose JSON is not its bytes, as Node's Buffer has. */
class Tagged extends Uint8Array {
  toJSON() {
    return "tagged";
  }
}

/** What a failed call threw, by the properties JavaScript sees. */
function failure(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    type: error instanceof TypeError,
  };
}

async function settle(call) {
  try {
    return { value: await call() };
  } catch (error) {
    return failure(error);
  }
}

globalThis.fetchletExports = {
  ping: () => "pong",

  shape() {
    const descriptor = Object.getOwnPropertyDescriptor(fetchlet.env, "DB");
    return {
      keys: Object.keys(DB),
      frozen: Object.isFrozen(DB),
      prototype: Object.getPrototypeOf(DB) === null,
      envKeys: Object.keys(fetchlet.env),
      writable: descriptor.writable,
    };
  },

  async calls() {
    const pending = DB.add(2, 3);
    const escaped = DB.escape("it's");
    return {
      promise: pending instanceof Promise,
      sum: await pending,
      escaped,
      // undefined arguments cross as null; a method may take any number.
      echoed: await DB.echo(undefined, null, { nested: [1, "two"] }),
      // A sync method's result is returned at once.
      empty: DB.nothing(),
      parallel: await Promise.all([DB.add(1, 1), DB.add(2, 2), DB.add(3, 3)]),
      method: DB.method(),
    };
  },

  async errors() {
    const sync = (call) => {
      try {
        return { value: call() };
      } catch (error) {
        return failure(error);
      }
    };
    return {
      application: await settle(() => DB.find("nobody")),
      uncoded: sync(() => DB.fail()),
      asyncArguments: await settle(() => DB.add("two", 3)),
      syncArguments: sync(() => DB.escape(1)),
      missing: sync(() => DB.escape()),
      extra: sync(() => DB.escape("a", "b")),
      host: await settle(() => DB.denied()),
      panicked: sync(() => DB.panics()),
      asyncPanicked: await settle(() => DB.panicsLater()),
      unencodable: sync(() => DB.echoSync(1n)),
      tooLarge: await settle(() => DB.large()),
    };
  },

  async limited() {
    const outcomes = [];
    for (const call of [
      () => DB.add(1, 2),
      () => DB.escape("x"),
      () => DB.add(3, 4),
      () => DB.escape("y"),
    ]) {
      outcomes.push(await settle(async () => call()));
    }
    return outcomes.map((outcome) => outcome.code ?? "ok");
  },

  // Leave a call running when the invocation ends.
  leave() {
    void DB.forever().catch(() => {});
    return "returned";
  },

  wait: () => DB.forever(),

  async reenter() {
    return {
      async: await settle(() => DB.reenter()),
      sync: (() => {
        try {
          return { value: DB.reenterSync() };
        } catch (error) {
          return failure(error);
        }
      })(),
    };
  },

  async binary() {
    const bytes = new Uint8Array([1, 2, 255]);
    // A view of two bytes in the middle of its buffer.
    const view = new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2);
    const reversed = await DB.reverse(bytes);
    const packet = DB.packet();
    return {
      parts: DB.parts(bytes, { nested: view, list: [new Uint8Array([5, 6]).buffer, "text"] }),
      empty: DB.parts(new Uint8Array(0), {
        nested: new Uint8Array(0),
        list: [new ArrayBuffer(0), ""],
      }),
      sum: await DB.sum(new Tagged([1, 2, 3]).subarray(1)),
      // The caller's bytes are copied, not moved.
      kept: Array.from(bytes),
      reversed: { array: reversed instanceof Uint8Array, bytes: Array.from(reversed) },
      packet: {
        header: packet.header,
        body: packet.body instanceof Uint8Array ? Array.from(packet.body) : packet.body,
        trailer: [packet.trailer[0], Array.from(packet.trailer[1])],
        keys: Object.keys(packet),
      },
      // Bytes also reads a string as its UTF-8, but not a number.
      wrong: await settle(() => DB.sum(5)),
      missing: await settle(() => DB.sum()),
    };
  },

  async subscribe() {
    const { topic, events } = await DB.subscribe("news");
    await until(events, () => events.opened);
    channels.send(events.id, "ack");
    await until(events, () => events.close !== null);
    return { topic, messages: events.messages, close: events.close };
  },

  async whole() {
    const channel = DB.open();
    await until(channel, () => channel.close !== null);
    return { messages: channel.messages, close: channel.close };
  },

  async keep() {
    const channel = await DB.hold();
    await until(channel, () => channel.opened);
    channels.send(channel.id, "kept");
    return "returned";
  },

  async withoutViews() {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__fetchletChannelViews");
    delete globalThis.__fetchletChannelViews;
    try {
      return await settle(() => DB.hold());
    } finally {
      Object.defineProperty(globalThis, "__fetchletChannelViews", descriptor);
    }
  },

  async handle() {
    const caller = await DB.whoami();
    const body = new Uint8Array(Array.from(caller, (character) => character.charCodeAt(0)));
    return { status: 200, headers: [], body };
  },
};
