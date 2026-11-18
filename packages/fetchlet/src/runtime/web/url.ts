// The URL interface on the fetchlet host's WHATWG URL parser.
//
// Parsing and the attribute setters run in Rust (`url.parse` / `url.set`);
// each returns every serialized component, which the object keeps. Getters
// read those strings without crossing the bridge. searchParams is the
// profile's URLSearchParams, linked both ways as the URL Standard specifies.

import { runtime } from "./runtime";
import { usvString } from "./idl";
import { hostProvides } from "./web-host";

const enum Part {
  Href,
  Protocol,
  Username,
  Password,
  Host,
  Hostname,
  Port,
  Pathname,
  Search,
  Hash,
  Origin,
}

type Parts = string[];

function host(operation: string, input: unknown): any {
  const reply = JSON.parse(runtime.__fetchletHost(operation, JSON.stringify(input)));
  if (!reply.ok) {
    const error = new TypeError(reply.error?.message ?? "URL host operation failed");
    (error as any).code = reply.error?.code;
    throw error;
  }
  return reply.value;
}

function parse(url: unknown, base: unknown): Parts | null {
  return host("url.parse", [usvString(url), base === undefined ? null : usvString(base)]);
}

interface Linked {
  params: any;
  /** Replace the list after the URL's query changed from the URL side. */
  replace(search: string): void;
}

/** A URLSearchParams whose changes run `update`, the URL's update steps. */
function linkedSearchParams(query: string, update: () => void): Linked {
  const Base: new (init?: unknown) => any = runtime.URLSearchParams;
  let replacing = false;
  const changed = () => {
    if (!replacing) {
      update();
    }
  };
  class URLSearchParams extends Base {
    append(name: string, value: string) {
      super.append(...arguments);
      changed();
    }
    delete(name: string) {
      super.delete(...arguments);
      changed();
    }
    set(name: string, value: string) {
      super.set(...arguments);
      changed();
    }
    sort() {
      super.sort();
      changed();
    }
  }
  const params = new URLSearchParams(query);
  return {
    params,
    replace(search) {
      replacing = true;
      try {
        for (const name of new Set<string>(params.keys())) {
          Base.prototype.delete.call(params, name);
        }
        for (const [name, value] of new Base(search)) {
          Base.prototype.append.call(params, name, value);
        }
      } finally {
        replacing = false;
      }
    },
  };
}

/** Parts for the URL that URL.parse constructs, consumed by the constructor. */
let parsed: Parts | null = null;

export class URLImpl {
  #parts: Parts;
  #linked: Linked | null = null;

  constructor(url: unknown, base?: unknown) {
    if (parsed !== null) {
      this.#parts = parsed;
      parsed = null;
      return;
    }
    if (arguments.length === 0) {
      throw new TypeError("URL requires a url");
    }
    const parts = parse(url, base);
    if (parts === null) {
      throw new TypeError("Invalid URL");
    }
    this.#parts = parts;
  }

  static canParse(url: unknown, base?: unknown) {
    if (arguments.length === 0) {
      throw new TypeError("URL.canParse requires a url");
    }
    return parse(url, base) !== null;
  }

  static parse(url: unknown, base?: unknown) {
    if (arguments.length === 0) {
      throw new TypeError("URL.parse requires a url");
    }
    const parts = parse(url, base);
    if (parts === null) {
      return null;
    }
    parsed = parts;
    return new URLImpl("");
  }

  static #check(value: URLImpl) {
    if (!(#parts in value)) {
      throw new TypeError("Illegal invocation");
    }
  }

  #set(setter: string, value: unknown) {
    URLImpl.#check(this);
    const parts = host("url.set", [this.#parts[Part.Href], setter, usvString(value)]);
    if (parts === null) {
      throw new TypeError("Invalid URL");
    }
    this.#parts = parts;
  }

  get href() {
    URLImpl.#check(this);
    return this.#parts[Part.Href];
  }

  set href(value: unknown) {
    this.#set("href", value);
    this.#linked?.replace(this.#parts[Part.Search]);
  }

  get origin() {
    URLImpl.#check(this);
    return this.#parts[Part.Origin];
  }

  get protocol() {
    URLImpl.#check(this);
    return this.#parts[Part.Protocol];
  }

  set protocol(value: unknown) {
    this.#set("protocol", value);
  }

  get username() {
    URLImpl.#check(this);
    return this.#parts[Part.Username];
  }

  set username(value: unknown) {
    this.#set("username", value);
  }

  get password() {
    URLImpl.#check(this);
    return this.#parts[Part.Password];
  }

  set password(value: unknown) {
    this.#set("password", value);
  }

  get host() {
    URLImpl.#check(this);
    return this.#parts[Part.Host];
  }

  set host(value: unknown) {
    this.#set("host", value);
  }

  get hostname() {
    URLImpl.#check(this);
    return this.#parts[Part.Hostname];
  }

  set hostname(value: unknown) {
    this.#set("hostname", value);
  }

  get port() {
    URLImpl.#check(this);
    return this.#parts[Part.Port];
  }

  set port(value: unknown) {
    this.#set("port", value);
  }

  get pathname() {
    URLImpl.#check(this);
    return this.#parts[Part.Pathname];
  }

  set pathname(value: unknown) {
    this.#set("pathname", value);
  }

  get search() {
    URLImpl.#check(this);
    return this.#parts[Part.Search];
  }

  set search(value: unknown) {
    this.#set("search", value);
    this.#linked?.replace(this.#parts[Part.Search]);
  }

  get searchParams() {
    URLImpl.#check(this);
    // The URLSearchParams update steps: an empty list removes the query.
    this.#linked ??= linkedSearchParams(this.#parts[Part.Search], () => {
      const serialized = this.#linked!.params.toString();
      this.#parts = host("url.set", [this.#parts[Part.Href], "search", serialized]);
    });
    return this.#linked.params;
  }

  get hash() {
    URLImpl.#check(this);
    return this.#parts[Part.Hash];
  }

  set hash(value: unknown) {
    this.#set("hash", value);
  }

  toString() {
    return this.href;
  }

  toJSON() {
    return this.href;
  }
}

// Web IDL attributes and operations are enumerable.
for (const name of Object.getOwnPropertyNames(URLImpl.prototype)) {
  if (name !== "constructor") {
    Object.defineProperty(URLImpl.prototype, name, {
      enumerable: true,
    });
  }
}
Object.defineProperty(URLImpl.prototype, Symbol.toStringTag, {
  value: "URL",
  configurable: true,
});
Object.defineProperty(URLImpl, "name", {
  value: "URL",
});

/** Whether the host provides the URL parser this class uses. */
export function hostHasUrlParser() {
  return hostProvides("url");
}
