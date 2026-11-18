// node:url, node:querystring and node:diagnostics_channel against Node's own.

import * as nodeDiagnostics from "node:diagnostics_channel";
import * as nodeQuerystring from "node:querystring";
import * as nodeUrl from "node:url";

import diagnostics from "@fetchlet/node/diagnostics-channel";
import querystring from "@fetchlet/node/querystring";
import url from "@fetchlet/node/url";
import { describe, expect, test } from "vite-plus/test";

/** The fields of a legacy Url as plain data. */
const fields = (value: object) => ({ ...value });

describe("url", () => {
  const legacy = [
    "http://user:pass@Host.Example.com:8080/p/a/t/h?query=string&a=1#hash",
    "https://example.com",
    "//example.com/path",
    "/just/a/path?x=1",
    "relative/path?x=y#frag",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "http://[::1]:3000/ipv6",
    "http://example.com/a b<c>",
    "  http://example.com\\back\\slash?x\\y  ",
    "file:///etc/hosts",
    "http://ex ample.com/",
    "http://münchen.de/",
    "HTTP://EXAMPLE.COM/UPPER",
    "?only=query",
    "#only-hash",
  ];

  test.each(legacy)("parse(%j) matches Node", (input) => {
    let theirs: object | string;
    try {
      theirs = fields(nodeUrl.parse(input));
    } catch (error) {
      theirs = (error as { code: string }).code;
    }
    let ours: object | string;
    try {
      ours = fields(url.parse(input));
    } catch (error) {
      ours = (error as { code: string }).code;
    }
    expect(ours).toStrictEqual(theirs);
  });

  test("parse with query parsing and slashes denoting the host", () => {
    for (const input of ["/p?a=1&a=2&b", "//host/p?x=1", "http://h/?"]) {
      expect(fields(url.parse(input, true, true))).toStrictEqual(
        fields(nodeUrl.parse(input, true, true)),
      );
    }
  });

  test("format matches Node for objects, strings and URLs", () => {
    const objects = [
      {
        protocol: "https",
        hostname: "example.com",
        pathname: "/a",
        query: { x: "1", y: ["2", "3"] },
      },
      { protocol: "http:", host: "h:81", pathname: "p", search: "s", hash: "h" },
      { protocol: "file", pathname: "/tmp/x" },
      { protocol: "mailto", pathname: "a@b.c" },
      { hostname: "::1", port: 8080, pathname: "/" },
    ];
    for (const object of objects) {
      expect(url.format(object)).toBe(nodeUrl.format(object as nodeUrl.UrlObject));
    }
    expect(url.format("http://a.com/x?y#z")).toBe(nodeUrl.format("http://a.com/x?y#z"));
    const whatwg = new URL("https://user:pw@xn--mnchen-3ya.de/p?q#f");
    for (const options of [
      {},
      { auth: false, fragment: false, search: false },
      { unicode: true },
    ]) {
      expect(url.format(whatwg, options)).toBe(nodeUrl.format(whatwg, options));
    }
  });

  test("resolve matches Node for common references", () => {
    const cases: [string, string][] = [
      ["/one/two/three", "four"],
      ["http://example.com/", "/one"],
      ["http://example.com/one", "/two"],
      ["http://example.com/a/b", "../c"],
      ["http://example.com/a/b", "//other.com/x"],
      ["http://example.com/a/b", "https://third.com/"],
      ["http://example.com/a/b?x", "?y"],
    ];
    for (const [from, to] of cases) {
      expect(url.resolve(from, to)).toBe(nodeUrl.resolve(from, to));
    }
  });

  test("file URLs and the domain helpers", () => {
    for (const path of ["/tmp/a b", "/tmp/100%/#?", "/dir/", "/back\\slash"]) {
      expect(url.pathToFileURL(path).href).toBe(
        nodeUrl
          .pathToFileURL(path, { windows: false })
          .href.replace(/^file:\/\/\/[A-Z]:/, "file://"),
      );
    }
    // Relative paths resolve from "/", the working directory of an instance.
    expect(url.pathToFileURL("relative/x").href).toBe("file:///relative/x");
    expect(url.fileURLToPath("file:///tmp/a%20b")).toBe("/tmp/a b");
    expect(() => url.fileURLToPath("http://x/")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_URL_SCHEME" }),
    );
    expect(() => url.fileURLToPath("file:///a%2Fb")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_FILE_URL_PATH" }),
    );
    for (const domain of ["münchen.de", "example.com", "xn--mnchen-3ya.de", "中文.com"]) {
      expect(url.domainToASCII(domain)).toBe(nodeUrl.domainToASCII(domain));
      expect(url.domainToUnicode(domain)).toBe(nodeUrl.domainToUnicode(domain));
    }
    const target = new URL("https://a:b@example.com:8443/p?q=1#h");
    expect(url.urlToHttpOptions(target)).toStrictEqual({ ...nodeUrl.urlToHttpOptions(target) });
  });
});

describe("querystring", () => {
  test.each([
    "a=1&b=2&a=3",
    "x=%20y+z&empty=&noequals",
    "bad=%zz%&%E4%B8%AD=%E6%96%87",
    "=value&&key=",
    "a[b]=1&c=%",
  ])("parse(%j) matches Node", (input) => {
    expect({ ...querystring.parse(input) }).toStrictEqual({ ...nodeQuerystring.parse(input) });
  });

  test("separators, maxKeys and stringify", () => {
    expect({ ...querystring.parse("a:1;b:2", ";", ":") }).toStrictEqual({
      ...nodeQuerystring.parse("a:1;b:2", ";", ":"),
    });
    expect({ ...querystring.parse("a=1&b=2&c=3", null!, null!, { maxKeys: 2 }) }).toStrictEqual({
      ...nodeQuerystring.parse("a=1&b=2&c=3", undefined, undefined, { maxKeys: 2 }),
    });
    const object = { a: [1, "two", true], b: null, c: undefined, d: 1n, e: NaN, "ü ": "é&" };
    expect(querystring.stringify(object)).toBe(nodeQuerystring.stringify(object as never));
    expect(querystring.stringify({ a: "b" }, ";", ":")).toBe(
      nodeQuerystring.stringify({ a: "b" }, ";", ":"),
    );
    expect(querystring.escape("a b&c/ü")).toBe(nodeQuerystring.escape("a b&c/ü"));
    expect(querystring.unescape("%zz%41")).toBe(nodeQuerystring.unescape("%zz%41"));
  });
});

describe("diagnostics_channel", () => {
  test("channels deliver messages to subscribers by name", () => {
    const received: unknown[] = [];
    const subscriber = (message: unknown, name: string | symbol) => received.push([name, message]);
    const channel = diagnostics.channel("fetchlet:test");
    expect(channel.hasSubscribers).toBe(false);
    diagnostics.subscribe("fetchlet:test", subscriber);
    expect(diagnostics.hasSubscribers("fetchlet:test")).toBe(true);
    expect(diagnostics.channel("fetchlet:test")).toBe(channel);
    channel.publish({ id: 1 });
    expect(diagnostics.unsubscribe("fetchlet:test", subscriber)).toBe(true);
    channel.publish({ id: 2 });
    expect(received).toStrictEqual([["fetchlet:test", { id: 1 }]]);
  });

  test("tracingChannel publishes the events Node publishes", async () => {
    const trace = (module: typeof nodeDiagnostics, name: string) => {
      const events: string[] = [];
      const channel = module.tracingChannel(name);
      const record = (event: string) => () => events.push(event);
      channel.subscribe({
        start: record("start"),
        end: record("end"),
        asyncStart: record("asyncStart"),
        asyncEnd: record("asyncEnd"),
        error: record("error"),
      });
      return { channel, events };
    };
    for (const name of ["sync", "promise", "callback"] as const) {
      const ours = trace(diagnostics as unknown as typeof nodeDiagnostics, `ours:${name}`);
      const theirs = trace(nodeDiagnostics, `theirs:${name}`);
      for (const { channel } of [ours, theirs]) {
        if (name === "sync") {
          expect(() =>
            channel.traceSync(() => {
              throw new Error("x");
            }, {}),
          ).toThrow("x");
        } else if (name === "promise") {
          await channel.tracePromise(async () => 1, {});
        } else {
          await new Promise((resolve) =>
            channel.traceCallback(
              (done: (error: null, value: number) => void) => done(null, 1),
              0,
              {},
              undefined,
              resolve,
            ),
          );
        }
      }
      expect(ours.events).toStrictEqual(theirs.events);
    }
  });
});
