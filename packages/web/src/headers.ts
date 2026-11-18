import { runtime } from "./runtime";
import { byteString } from "./idl";
import { headerIterator } from "./header-iterator";

const immutableHeaders = new WeakSet<object>();

export function makeHeadersImmutable(headers: object) {
  immutableHeaders.add(headers);
}

/** Web IDL record<ByteString, ByteString>: convert each enumerable own key, then its value. */
function headerRecord(init: object): [string, string][] {
  const result: [string, string][] = [];
  for (const key of Reflect.ownKeys(init)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(init, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    const name = byteString(key);
    result.push([name, byteString((init as any)[key])]);
  }
  return result;
}

class HeadersImpl {
  private pairs: [string, string][] = [];

  constructor(init?: any) {
    if (init === undefined) {
      return;
    }
    if (init === null || (typeof init !== "object" && typeof init !== "function")) {
      throw new TypeError("Expected HeadersInit");
    }
    const iterator = init[Symbol.iterator];
    const pairs = iterator !== undefined && iterator !== null ? init : headerRecord(init);
    for (const pair of pairs) {
      const values = Array.from(pair);
      if (values.length !== 2) {
        throw new TypeError("Header pair must contain two values");
      }
      this.append(values[0] as string, values[1] as string);
    }
  }

  private key(name: string) {
    name = byteString(name).toLowerCase();
    if (!/^[!#$%&'*+.^_`|~\da-z-]+$/.test(name)) {
      throw new TypeError("Invalid header name");
    }
    return name;
  }

  append(name: string, value: string) {
    if (arguments.length < 2) {
      throw new TypeError("append requires a name and value");
    }
    name = this.key(name);
    value = byteString(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
    if (/[\r\n\0]/.test(value)) {
      throw new TypeError("Invalid header value");
    }
    if (immutableHeaders.has(this)) {
      throw new TypeError("Headers are immutable");
    }
    this.pairs.push([name, value]);
  }

  get(name: string) {
    if (arguments.length === 0) {
      throw new TypeError("get requires a name");
    }
    name = this.key(name);
    const values = this.pairs.filter(([n]) => n === name).map(([, v]) => v);
    return values.length ? values.join(", ") : null;
  }

  getSetCookie() {
    return this.pairs.filter(([n]) => n === "set-cookie").map(([, v]) => v);
  }

  has(name: string) {
    if (arguments.length === 0) {
      throw new TypeError("has requires a name");
    }
    return this.get(name) !== null;
  }

  delete(name: string) {
    if (arguments.length === 0) {
      throw new TypeError("delete requires a name");
    }
    name = this.key(name);
    if (immutableHeaders.has(this)) {
      throw new TypeError("Headers are immutable");
    }
    this.pairs = this.pairs.filter(([n]) => n !== name);
  }

  set(name: string, value: string) {
    if (arguments.length < 2) {
      throw new TypeError("set requires a name and value");
    }
    const validated = new HeadersImpl([[name, value]]);
    const key = this.key(name);
    if (immutableHeaders.has(this)) {
      throw new TypeError("Headers are immutable");
    }
    const index = this.pairs.findIndex(([stored]) => stored === key);
    if (index < 0) {
      this.pairs.push(...validated.pairs);
    } else {
      this.pairs[index] = validated.pairs[0];
      this.pairs = this.pairs.filter(([stored], position) => stored !== key || position === index);
    }
  }

  private sortedPairs(): [string, string][] {
    const entries: [string, string][] = [];
    for (const name of [...new Set(this.pairs.map(([name]) => name))].sort()) {
      if (name === "set-cookie") {
        for (const value of this.getSetCookie()) {
          entries.push([name, value]);
        }
      } else {
        entries.push([name, this.get(name)!]);
      }
    }
    return entries;
  }

  entries(): IterableIterator<[string, string]> {
    return headerIterator(() => this.sortedPairs(), "entries");
  }

  keys(): IterableIterator<string> {
    return headerIterator(() => this.sortedPairs(), "keys");
  }

  values(): IterableIterator<string> {
    return headerIterator(() => this.sortedPairs(), "values");
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(fn: Function, thisArg?: any) {
    for (const [key, value] of this) {
      fn.call(thisArg, value, key, this);
    }
  }
}

Object.defineProperty(HeadersImpl, "name", { value: "Headers" });

runtime.Headers ??= HeadersImpl;
