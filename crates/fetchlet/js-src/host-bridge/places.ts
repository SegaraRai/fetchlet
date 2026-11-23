// Resources Rust places into JSON values by path: byte arrays and channel
// objects, at JSON Pointer reference tokens that Rust checked name a value.

/** Put `item` at `path` in `root`, returning the new root. */
export function placeAt(root: unknown, path: string[], item: unknown): unknown {
  const key = path[path.length - 1];
  if (key === undefined) {
    return item;
  }
  let parent = root as Record<string, unknown>;
  for (const token of path.slice(0, -1)) {
    parent = parent[token] as Record<string, unknown>;
  }
  // A data property, even for a key such as "__proto__".
  Object.defineProperty(parent, key, {
    value: item,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return root;
}

/** The channel object of a channel Rust lent, built by the Web API profile. */
export function lentChannel(channel: number): unknown {
  const views = globalThis.__fetchletChannelViews;
  if (!views?.lend) {
    throw new TypeError("Channels need the fetchlet Web API profile");
  }
  return views.lend(channel);
}
