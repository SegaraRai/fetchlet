// Channels the host holds for the current invocation: an accepted server
// WebSocket, and channels opened from env bindings. JavaScript sends through
// host operations; Rust delivers opens, messages and closes in the host
// pump, each channel's in order. Every entry belongs to the current
// invocation and is forgotten when it ends.

import { dispatch, putBytes, takeBytes } from "./host.ts";
import type { ChannelArrival } from "./wire.ts";

interface PendingWrite {
  resolve(): void;
  reject(error: unknown): void;
}

interface ChannelEntry {
  listener: ChannelListener;
  closed: Promise<void>;
  resolveClosed(): void;
  write?: PendingWrite;
}

const channels = new Map<number, ChannelEntry>();
// The WebSocket upgrade the current invocation accepted, until it ends.
let acceptedUpgrade: number | undefined;

export function hasOpenChannels(): boolean {
  return channels.size > 0;
}

function track(id: number, listener: ChannelListener): void {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  channels.set(id, {
    listener,
    closed,
    resolveClosed,
  });
}

/** Remove an entry whose channel ended; a pending write fails with it. */
function end(id: number, entry: ChannelEntry): void {
  channels.delete(id);
  entry.write?.reject(new TypeError("The channel closed"));
  entry.write = undefined;
  entry.resolveClosed();
}

function forget(id: number): void {
  const entry = channels.get(id);
  if (entry) {
    end(id, entry);
  }
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
    try {
      entry.listener.close(arrival.close.code, arrival.close.reason);
    } finally {
      end(arrival.channel, entry);
    }
  } else if (arrival.refused !== undefined) {
    try {
      entry.listener.refused?.(arrival.refused.message);
    } finally {
      end(arrival.channel, entry);
    }
  } else if (arrival.end === true) {
    entry.listener.end?.();
  } else if (arrival.secure === true) {
    entry.listener.secure?.();
  } else if (arrival.open === true) {
    entry.listener.open();
  } else if (arrival.written === true) {
    const write = entry.write;
    entry.write = undefined;
    write?.resolve();
  } else if (bytes !== undefined) {
    entry.listener.message(bytes);
  } else if (arrival.text !== undefined) {
    entry.listener.message(arrival.text);
  }
  return true;
}

export const channelRegistry: ChannelRegistry = Object.freeze<ChannelRegistry>({
  upgrade(listener): number {
    // Throws unless the request asked for an upgrade the host can hold.
    const id = dispatch<number>("websocket.upgrade", null);
    track(id, listener);
    acceptedUpgrade = id;
    return id;
  },
  accepted(): number | undefined {
    return acceptedUpgrade;
  },
  open(service, options, listener): number {
    // Throws for an unknown service or over Limits::open_channels.
    const id = dispatch<number>("channel.open", {
      service,
      options: options ?? null,
    });
    track(id, listener);
    return id;
  },
  connect(address, listener): number {
    // Throws without a socket service, for an address its policy refuses,
    // or over Limits::open_channels.
    const id = dispatch<number>("socket.open", address);
    track(id, listener);
    return id;
  },
  endWrites(id): void {
    if (channels.has(id)) {
      dispatch("socket.end", id);
    }
  },
  startTls(id): void {
    if (!channels.has(id)) {
      throw new TypeError("The socket closed");
    }
    dispatch("socket.startTls", id);
  },
  send(id, data): void {
    if (!channels.has(id)) {
      return;
    }
    if (typeof data === "string") {
      dispatch("channel.send", {
        id,
        text: data,
      });
    } else {
      dispatch("channel.send", {
        id,
        bytes: putBytes(data),
      });
    }
  },
  write(id, data): Promise<void> {
    const entry = channels.get(id);
    if (!entry) {
      return Promise.reject(new TypeError("The channel closed"));
    }
    if (entry.write) {
      return Promise.reject(new TypeError("A write is pending"));
    }
    return new Promise<void>((resolve, reject) => {
      dispatch("channel.write", {
        id,
        bytes: putBytes(data),
      });
      entry.write = { resolve, reject };
    });
  },
  pause(id, paused): void {
    if (channels.has(id)) {
      dispatch("channel.pause", {
        id,
        paused,
      });
    }
  },
  close(id, code, reason): void {
    if (channels.has(id)) {
      dispatch("channel.close", {
        id,
        code,
        reason,
      });
    }
  },
  buffered(id): number {
    return channels.has(id) ? dispatch<number>("channel.buffered", id) : 0;
  },
  retain(id): boolean {
    // An upgrade the handler accepted but did not return closes now; the
    // invocation's other channels stay until it ends.
    const accepted = acceptedUpgrade;
    if (accepted !== undefined && accepted !== id) {
      acceptedUpgrade = undefined;
      forget(accepted);
    }
    return id !== undefined && id === acceptedUpgrade && channels.has(id);
  },
  async hold(id): Promise<void> {
    const entry = channels.get(id);
    if (!entry) {
      return;
    }
    entry.listener.open();
    await entry.closed;
  },
  closeAll(): void {
    acceptedUpgrade = undefined;
    for (const id of channels.keys()) {
      forget(id);
    }
  },
});
