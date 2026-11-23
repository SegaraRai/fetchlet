// Byte arrays and context in calls: what an export receives from Rust and
// returns to it beside its JSON.

const KEYS = fetchlet.env.KEYS;

/** A Uint8Array with toJSON, as Node's Buffer has. */
class Encoded extends Uint8Array {
  toJSON() {
    return { type: "Encoded", data: Array.from(this) };
  }
}

function describe(bytes) {
  return {
    type: Object.prototype.toString.call(bytes),
    data: Array.from(bytes),
  };
}

globalThis.fetchletExports = {
  /** Describe the byte arrays Rust placed in the arguments. */
  received(options, positional) {
    return {
      name: options.name,
      image: describe(options.image),
      positional: describe(positional),
    };
  },
  /** Return byte arrays inside JSON: nested, in a list and with toJSON. */
  thumbnail(name) {
    return {
      name,
      image: new Uint8Array([1, 2, 3]),
      list: [new Uint16Array([0x0201]).buffer, "text"],
      encoded: Encoded.from([9]),
      empty: new Uint8Array(0),
    };
  },
  /** Return a byte array as the whole result. */
  raw(length) {
    return new Uint8Array(length).fill(7);
  },
  /** Hand the bytes Rust passed back as the result. */
  echo(bytes) {
    return bytes.subarray(1);
  },
  /** The caller a function binding sees during the call. */
  caller() {
    return KEYS.caller();
  },
  /** Undefined is not JSON. */
  nothing() {
    return undefined;
  },
};
