// Channels Rust lends to calls, over the bridge's channel registry. The
// Web API profile builds channel objects with `__fetchletChannelViews.lend`;
// this stand-in records what arrives instead.

const channels = globalThis.__fetchletChannels;

Object.defineProperty(globalThis, "__fetchletChannelViews", {
  value: Object.freeze({
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
  }),
});

async function until(record, done) {
  while (!done()) {
    await record.changed();
  }
}

globalThis.fetchletExports = {
  /**
   * Report `steps` steps on the lent progress channel and close it; Rust
   * reads them after the call.
   */
  async progress(options) {
    const { progress, steps } = options;
    await until(progress, () => progress.opened);
    for (let step = 1; step <= steps; step += 1) {
      channels.send(progress.id, `step ${step}`);
    }
    channels.close(progress.id, 1000, "done");
    return { steps, keys: Object.keys(options) };
  },
  /** Echo what Rust sends on a positional channel until Rust closes. */
  async echo(prefix, channel) {
    await until(channel, () => channel.opened);
    let echoed = 0;
    while (channel.close === null) {
      while (channel.messages.length > 0) {
        channels.send(channel.id, `${prefix}${channel.messages.shift()}`);
        echoed += 1;
      }
      await channel.changed();
    }
    return { echoed, close: channel.close };
  },
  /** Send on the channel and return without closing it. */
  async leave(channel) {
    await until(channel, () => channel.opened);
    channels.send(channel.id, "left open");
    return "returned";
  },
  /** Where the lent channels landed. */
  shape(first, second) {
    return {
      first: Object.getPrototypeOf(first) === Object.prototype,
      own: Object.hasOwn(first, "__proto__") && typeof first["__proto__"].id === "number",
      nested: typeof second.list[1].id === "number",
      kept: second.list[0],
    };
  },
};
