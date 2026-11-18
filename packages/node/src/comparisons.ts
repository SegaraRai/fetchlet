// Deep equality as Node's assert and util.isDeepStrictEqual define it. The
// strict comparison also compares prototypes, symbol keys and primitives
// with Object.is; the loose one compares primitives with ==.

const tag = (value: unknown) => Object.prototype.toString.call(value).slice(8, -1);

function isBoxedPrimitive(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ["Number", "String", "Boolean", "BigInt", "Symbol"].includes(tag(value))
  );
}

function deepEqual(a: unknown, b: unknown, memo: Map<object, object>, strict: boolean): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    if (strict || (typeof a === "object" && a !== null) || (typeof b === "object" && b !== null)) {
      return false;
    }
    // Loose equality, with NaN equal to itself.
    // eslint-disable-next-line eqeqeq
    return a == b || (Number.isNaN(a) && Number.isNaN(b));
  }
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }
  if (tag(a) !== tag(b)) {
    return false;
  }
  if (memo.get(a) === b) {
    return true;
  }
  memo.set(a, b);
  if (a instanceof Date) {
    return Object.is(a.getTime(), (b as Date).getTime()) && sameKeys(a, b, memo, strict);
  }
  if (a instanceof RegExp) {
    const other = b as RegExp;
    return a.source === other.source && a.flags === other.flags && a.lastIndex === other.lastIndex;
  }
  if (a instanceof Error) {
    const other = b as Error;
    if (a.message !== other.message || a.name !== other.name) {
      return false;
    }
  }
  if (isBoxedPrimitive(a)) {
    const left = (a as { valueOf(): unknown }).valueOf();
    const right = (b as { valueOf(): unknown }).valueOf();
    if (!Object.is(left, right)) {
      return false;
    }
  }
  if (ArrayBuffer.isView(a)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const view = b as ArrayBufferView;
    const right = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (left.length !== right.length || left.some((byte, index) => byte !== right[index])) {
      return false;
    }
    return sameKeys(a, b, memo, strict, true);
  }
  if (a instanceof ArrayBuffer) {
    return deepEqual(new Uint8Array(a), new Uint8Array(b as ArrayBuffer), memo, strict);
  }
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>;
    if (a.size !== other.size) {
      return false;
    }
    for (const [key, item] of a) {
      if (other.has(key)) {
        if (!deepEqual(item, other.get(key), memo, strict)) {
          return false;
        }
        continue;
      }
      if (typeof key !== "object" || key === null) {
        return false;
      }
      let matched = false;
      for (const [otherKey, otherItem] of other) {
        if (deepEqual(key, otherKey, memo, strict) && deepEqual(item, otherItem, memo, strict)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        return false;
      }
    }
    return sameKeys(a, b, memo, strict);
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>;
    if (a.size !== other.size) {
      return false;
    }
    for (const item of a) {
      if (other.has(item)) {
        continue;
      }
      if (typeof item !== "object" || item === null) {
        return false;
      }
      if (![...other].some((candidate) => deepEqual(item, candidate, memo, strict))) {
        return false;
      }
    }
    return sameKeys(a, b, memo, strict);
  }
  return sameKeys(a, b, memo, strict);
}

function sameKeys(
  a: object,
  b: object,
  memo: Map<object, object>,
  strict: boolean,
  skipIndices = false,
): boolean {
  // Loose comparison ignores symbol keys, as Node's does.
  const keysOf = (value: object) =>
    (strict ? Reflect.ownKeys(value) : Object.keys(value)).filter(
      (key) =>
        Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
        !(skipIndices && typeof key === "string" && /^\d+$/.test(key)),
    );
  const left = keysOf(a);
  const right = keysOf(b);
  if (left.length !== right.length) {
    return false;
  }
  for (const key of left) {
    if (!Object.prototype.propertyIsEnumerable.call(b, key)) {
      return false;
    }
    if (
      !deepEqual(
        (a as Record<PropertyKey, unknown>)[key],
        (b as Record<PropertyKey, unknown>)[key],
        memo,
        strict,
      )
    ) {
      return false;
    }
  }
  return true;
}

export function isDeepEqual(a: unknown, b: unknown, strict: boolean): boolean {
  return deepEqual(a, b, new Map(), strict);
}
