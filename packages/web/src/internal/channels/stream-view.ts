// The byte stream view of a channel: its binary messages as a readable,
// and a writable whose writes Rust queues as binary messages within the
// channel budgets. A full reader pauses delivery, so Rust's sender waits.

import { runtime } from "../runtime/runtime";
import { bufferSourceBytes } from "./bytes";
import type { ChannelListener, ChannelRegistry } from "./registry";

/** The byte stream view of a channel. */
export interface ChannelStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<BufferSource>;
}

/**
 * The byte stream view of channel `id`: its binary messages as `readable`,
 * and `writable`, whose writes wait for `opened` and Rust's room. The
 * listener drives it.
 */
export function streamView(
  registry: ChannelRegistry,
  id: number,
  opened: Promise<unknown>,
): ChannelStream & { listener: ChannelListener } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let paused = false;
  let ended = false;
  const fail = (error: unknown) => {
    if (!ended) {
      ended = true;
      controller.error(error);
    }
  };
  const readable: ReadableStream<Uint8Array> = new runtime.ReadableStream({
    start(start: ReadableStreamDefaultController<Uint8Array>) {
      controller = start;
    },
    pull() {
      // The reader has room again: Rust delivers what it held back.
      if (paused) {
        paused = false;
        registry.pause(id, false);
      }
    },
    cancel() {
      ended = true;
      registry.close(id, 1000, "");
    },
  });
  const writable: WritableStream<BufferSource> = new runtime.WritableStream({
    async write(chunk: unknown) {
      const bytes = bufferSourceBytes(chunk);
      await opened;
      await registry.write(id, bytes);
    },
    close() {
      registry.close(id, 1000, "");
    },
    abort() {
      registry.close(id, 1000, "");
    },
  });
  const listener: ChannelListener = {
    open() {},
    message(data) {
      if (ended) {
        return;
      }
      if (typeof data === "string") {
        fail(new TypeError("A text message arrived on a byte stream"));
        // 1003: the endpoint cannot accept this type of data.
        registry.close(id, 1003, "text message on a byte stream");
        return;
      }
      controller.enqueue(data);
      // The reader is full: Rust holds further messages, and its sender
      // waits for room.
      if (!paused && (controller.desiredSize ?? 0) <= 0) {
        paused = true;
        registry.pause(id, true);
      }
    },
    close(code, reason) {
      // 1006: no close arrived; 1011: the peer failed.
      if (code === 1006 || code === 1011) {
        fail(new TypeError(reason || "The channel ended without a close"));
      } else if (!ended) {
        ended = true;
        controller.close();
      }
    },
    refused(message) {
      fail(new TypeError(message));
    },
  };
  return {
    readable,
    writable,
    listener,
  };
}
