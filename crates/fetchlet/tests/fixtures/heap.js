// JavaScript that exhausts the engine's heap, for the heap limits to stop.

const grow = (keep) => {
  for (;;) {
    // Rows are built by pushing: V8 does not deliver termination to a hot
    // loop around `new Array(n).fill(value)` for large n.
    const row = [];
    for (let index = 0; index < 1024; index += 1) {
      row.push(index);
    }
    keep.push(row);
  }
};

globalThis.fetchletExports = {
  /** Return at once. */
  ready() {
    return "ready";
  },
  /** Grow an array of arrays until the heap is exhausted. */
  grow() {
    grow([]);
  },
  /** Catch the out-of-memory error, free the memory and carry on. */
  swallow() {
    const keep = [];
    for (;;) {
      try {
        grow(keep);
      } catch {
        keep.length = 0;
      }
    }
  },
  /** Allocate an ArrayBuffer and report the error's name if it fails. */
  buffer(bytes) {
    try {
      return new ArrayBuffer(bytes).byteLength;
    } catch (error) {
      return error.name;
    }
  },
};
