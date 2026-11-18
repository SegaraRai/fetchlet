// URLImpl over a fake host whose `url.parse` and `url.set` answer with Node's
// WHATWG parser, the same component list the Rust host returns. The tests
// pin the JavaScript side: which calls cross the bridge, and how
// searchParams stays linked to the URL.

import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { URLImpl } from "../src/internal/url/url.ts";

const calls: string[] = [];

vi.mock(import("../src/internal/runtime/runtime.ts"), async () => {
  const { isolatedRuntime } = await import("./isolated-runtime.ts");
  const parts = (url: URL) => [
    url.href,
    url.protocol,
    url.username,
    url.password,
    url.host,
    url.hostname,
    url.port,
    url.pathname,
    url.search,
    url.hash,
    url.origin,
  ];
  const parse = (input: string, base?: string) => {
    try {
      return new URL(input, base);
    } catch {
      return null;
    }
  };
  return isolatedRuntime([], (operation, input) => {
    calls.push(operation);
    const args = JSON.parse(input);
    if (operation === "url.parse") {
      const url = parse(args[0], args[1] ?? undefined);
      return JSON.stringify({ ok: true, value: url && parts(url) });
    }
    if (operation === "url.set") {
      const [href, setter, value] = args;
      if (setter === "href") {
        const url = parse(value);
        return JSON.stringify({ ok: true, value: url && parts(url) });
      }
      const url = new URL(href);
      (url as unknown as Record<string, string>)[setter] = value;
      return JSON.stringify({ ok: true, value: parts(url) });
    }
    return JSON.stringify({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "unknown operation " + operation },
    });
  });
});

beforeEach(() => {
  calls.length = 0;
});

describe("URLImpl", () => {
  test("parses once and reads every component without the host", () => {
    const url = new URLImpl("../b?x=1#h", "https://user:pw@app.test:8443/a/c");
    expect(calls).toStrictEqual(["url.parse"]);
    expect({
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      username: url.username,
      password: url.password,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    }).toStrictEqual({
      href: "https://user:pw@app.test:8443/b?x=1#h",
      origin: "https://app.test:8443",
      protocol: "https:",
      username: "user",
      password: "pw",
      host: "app.test:8443",
      hostname: "app.test",
      port: "8443",
      pathname: "/b",
      search: "?x=1",
      hash: "#h",
    });
    expect(calls).toStrictEqual(["url.parse"]);
    expect(String(url)).toBe(url.href);
    expect(JSON.stringify({ url })).toBe(JSON.stringify({ url: url.href }));
  });

  test("invalid input throws, and canParse and parse report it instead", () => {
    expect(() => new URLImpl("not a url")).toThrow("Invalid URL");
    expect(() => new (URLImpl as new () => URLImpl)()).toThrow("URL requires a url");
    expect(URLImpl.canParse("/path", "https://app.test")).toBe(true);
    expect(URLImpl.canParse("/path")).toBe(false);
    expect(URLImpl.parse("nope")).toBeNull();
    const parsed = URLImpl.parse("/p", "https://app.test/");
    expect(parsed).toBeInstanceOf(URLImpl);
    expect(parsed!.href).toBe("https://app.test/p");
  });

  test("URL.parse hands its parts only to the URL it constructs", () => {
    URLImpl.parse("https://first.test/");
    const next = new URLImpl("https://second.test/");
    expect(next.href).toBe("https://second.test/");
  });

  test("setters ask the host and keep its serialization", () => {
    const url = new URLImpl("https://app.test/a");
    calls.length = 0;
    url.pathname = "/b c";
    url.port = "8080";
    url.hash = "top";
    expect(url.href).toBe("https://app.test:8080/b%20c#top");
    expect(calls).toStrictEqual(["url.set", "url.set", "url.set"]);
    expect(() => {
      url.href = "not a url";
    }).toThrow("Invalid URL");
    expect(url.href).toBe("https://app.test:8080/b%20c#top");
  });

  test("searchParams changes update the URL, and URL changes update searchParams", () => {
    const url = new URLImpl("https://app.test/?a=1&b=2");
    const params = url.searchParams;
    expect(url.searchParams).toBe(params);
    params.append("c", "3");
    expect(url.search).toBe("?a=1&b=2&c=3");
    params.delete("a");
    params.sort();
    expect(url.href).toBe("https://app.test/?b=2&c=3");
    url.search = "?z=9";
    expect([...params]).toStrictEqual([["z", "9"]]);
    url.href = "https://app.test/?y=8";
    expect(params.get("y")).toBe("8");
    params.delete("y");
    expect(url.href).toBe("https://app.test/");
  });

  test("members check their receiver and are enumerable", () => {
    const href = Object.getOwnPropertyDescriptor(URLImpl.prototype, "href")!;
    expect(href.enumerable).toBe(true);
    expect(() => href.get!.call({})).toThrow("Illegal invocation");
    expect(Object.prototype.toString.call(new URLImpl("https://app.test/"))).toBe("[object URL]");
    expect(URLImpl.name).toBe("URL");
  });
});
