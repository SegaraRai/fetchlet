// duplexPair: two Duplex streams, each reading what the other writes.

import Stream from "readable-stream/lib/stream.js";

/** One end of a duplexPair: what it writes, the other end reads. */
class DuplexSide extends Stream.Duplex {
  #other: DuplexSide | undefined;
  #callback: (() => void) | undefined;

  constructor(options?: object) {
    super(options);
  }

  connect(other: DuplexSide) {
    this.#other = other;
  }

  _read() {
    const callback = this.#callback;
    if (callback) {
      this.#callback = undefined;
      callback();
    }
  }

  _write(chunk: Uint8Array, _encoding: string, callback: () => void) {
    if (chunk.length === 0) {
      queueMicrotask(callback);
      return;
    }
    this.#other!.push(chunk);
    this.#other!.#callback = callback;
  }

  _final(callback: () => void) {
    this.#other!.on("end", callback);
    this.#other!.push(null);
  }
}

/** Two Duplex streams, each reading what the other writes. */
export function duplexPair(options?: object): [unknown, unknown] {
  const first = new DuplexSide(options);
  const second = new DuplexSide(options);
  first.connect(second);
  second.connect(first);
  return [first, second];
}
