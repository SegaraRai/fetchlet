// Channels the host holds for the current invocation, such as an accepted
// server WebSocket. JavaScript sends through host operations; Rust delivers
// messages and closes in the host pump, each channel's in order. Every entry
// belongs to the current invocation and is forgotten when it ends.

import { dispatch, putBytes, takeBytes } from "./host.ts";
import type { ChannelArrival } from "./wire.ts";

interface ChannelEntry {
  listener: ChannelListener;
  closed: Promise<void>;
  resolveClosed(): void;
}

const channels = new Map<number, ChannelEntry>();
// The WebSocket upgrade the current invocation accepted, until it ends.
let acceptedUpgrade: number | undefined;

export function hasOpenChannels(): boolean {
  return channels.size > 0;
}

function forget(id: number): void {
  const entry = channels.get(id);
  channels.delete(id);
  entry?.resolveClosed();
}

/** Deliver an arrival if the event is one. Returns whether it was. */
export function completeChannel(event: object): boolean {
  if (!("channel" in event)) {
    return false;
  }
  const arrival = event as ChannelArrival;
  // Take the bytes even for a forgotten channel, so the store stays empty.
  const bytes = arrival.bytes === undefined ? undefined : takeBytes(arrival.bytes);
  const entry = channels.get(arrival.channel);
  if (!entry) {
    return true;
  }
  if (arrival.close !== undefined) {
    // The channel has left the host table; nothing more arrives on it.
    channels.delete(arrival.channel);
    try {
      entry.listener.close(arrival.close.code, arrival.close.reason);
    } finally {
      entry.resolveClosed();
    }
  } else if (bytes !== undefined) {
    entry.listener.message(bytes);
  } else if (arrival.text !== undefined) {
    entry.listener.message(arrival.text);
  }
  return true;
}

export const channelRegistry: ChannelRegistry = Object.freeze<ChannelRegistry>({
  upgrade(listener) {
    // Throws unless the request asked for an upgrade the host can hold.
    const id = dispatch<number>("websocket.upgrade", null);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    channels.set(id, { listener, closed, resolveClosed });
    acceptedUpgrade = id;
    return id;
  },
  accepted() {
    return acceptedUpgrade;
  },
  send(id, data) {
    if (!channels.has(id)) {
      return;
    }
    if (typeof data === "string") {
      dispatch("channel.send", { id, text: data });
    } else {
      dispatch("channel.send", { id, bytes: putBytes(data) });
    }
  },
  close(id, code, reason) {
    if (channels.has(id)) {
      dispatch("channel.close", { id, code, reason });
    }
  },
  buffered(id) {
    return channels.has(id) ? dispatch<number>("channel.buffered", id) : 0;
  },
  retain(id) {
    // Deleting the entry being visited keeps a Map's iteration going.
    for (const key of channels.keys()) {
      if (key !== id) {
        forget(key);
      }
    }
    return id !== undefined && channels.has(id);
  },
  async hold(id) {
    const entry = channels.get(id);
    if (!entry) {
      return;
    }
    entry.listener.open();
    await entry.closed;
  },
  closeAll() {
    acceptedUpgrade = undefined;
    for (const id of channels.keys()) {
      forget(id);
    }
  },
});
