type Kind = "entries" | "keys" | "values";

interface State {
  entries: () => [string, string][];
  index: number;
  kind: Kind;
}

const states = new WeakMap<object, State>();

const intrinsicIterator = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

const prototype = Object.create(intrinsicIterator);

Object.defineProperty(prototype, "next", {
  configurable: true,
  enumerable: true,
  writable: true,
  value: function next() {
    const state = states.get(this);
    if (!state) {
      throw new TypeError("Invalid Headers iterator receiver");
    }
    const entry = state.entries()[state.index];
    if (!entry) {
      return {
        value: undefined,
        done: true,
      };
    }
    state.index++;
    const value = state.kind === "keys" ? entry[0] : state.kind === "values" ? entry[1] : entry;
    return {
      value,
      done: false,
    };
  },
});

Object.defineProperty(prototype, Symbol.toStringTag, {
  value: "Headers Iterator",
  configurable: true,
});

/** Recompute the sorted view at every step, as required by Web IDL live iteration. */
export function headerIterator(entries: State["entries"], kind: Kind): any {
  const iterator = Object.create(prototype);
  states.set(iterator, {
    entries,
    index: 0,
    kind,
  });
  return iterator;
}
