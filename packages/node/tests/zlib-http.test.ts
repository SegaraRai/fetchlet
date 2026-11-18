// node:zlib with a stand-in for the host's compression operations, and
// node:http and node:https requests over fetch against a local Node server.

import * as nodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as nodeZlib from "node:zlib";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { installHost } from "./host.ts";

installHost();
const zlib = (await import("@fetchlet/node/zlib")).default;
const http = (await import("@fetchlet/node/http")).default;
const https = (await import("@fetchlet/node/https")).default;

const text = "fetchlet compresses this text ".repeat(20);
const nodeBytes = (value: Uint8Array) =>
  Buffer.from(value.buffer, value.byteOffset, value.byteLength);

describe("zlib", () => {
  test.each([
    ["gzipSync", "gunzipSync"],
    ["deflateSync", "inflateSync"],
    ["deflateRawSync", "inflateRawSync"],
    ["brotliCompressSync", "brotliDecompressSync"],
  ] as const)("%s output decompresses with Node, and %s reads Node's", (compress, decompress) => {
    const ours = zlib[compress](text);
    expect(nodeZlib[decompress](nodeBytes(ours)).toString()).toBe(text);
    const theirs = nodeZlib[compress](text);
    expect(zlib[decompress](theirs).toString()).toBe(text);
  });

  test("unzip detects gzip and deflate", () => {
    expect(zlib.unzipSync(nodeZlib.gzipSync(text)).toString()).toBe(text);
    expect(zlib.unzipSync(nodeZlib.deflateSync(text)).toString()).toBe(text);
  });

  test("callbacks, errors and maxOutputLength", async () => {
    const result = await new Promise<Uint8Array>((resolve, reject) =>
      zlib.gzip(text, (error, value) => (error ? reject(error) : resolve(value!))),
    );
    expect(nodeZlib.gunzipSync(nodeBytes(result)).toString()).toBe(text);
    expect(() => zlib.inflateSync(Buffer.from("not deflate"))).toThrow(
      expect.objectContaining({ code: "Z_DATA_ERROR", errno: -3 }),
    );
    expect(() => zlib.gunzipSync(nodeZlib.gzipSync(text), { maxOutputLength: 10 })).toThrow(
      expect.objectContaining({ code: "ERR_BUFFER_TOO_LARGE" }),
    );
  });

  test("stream classes transform chunks", async () => {
    const gzip = zlib.createGzip();
    const chunks: Uint8Array[] = [];
    gzip.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    const ended = new Promise((resolve) => gzip.on("end", resolve));
    gzip.write(text.slice(0, 50));
    gzip.end(text.slice(50));
    await ended;
    expect(nodeZlib.gunzipSync(Buffer.concat(chunks.map(nodeBytes))).toString()).toBe(text);
  });

  test("crc32 and constants match Node", () => {
    for (const input of ["", "fetchlet", "éè"]) {
      expect(zlib.crc32(input)).toBe(nodeZlib.crc32(input));
    }
    expect(zlib.crc32("b", zlib.crc32("a"))).toBe(nodeZlib.crc32("b", nodeZlib.crc32("a")));
    // ZLIB_VERNUM names the zlib release, which the host does not use.
    for (const [name, value] of Object.entries(zlib.constants)) {
      if (name === "ZLIB_VERNUM") {
        continue;
      }
      expect([name, value]).toStrictEqual([
        name,
        (nodeZlib.constants as Record<string, number>)[name],
      ]);
    }
  });
});

describe("http", () => {
  let server: nodeHttp.Server;
  let base: string;

  beforeAll(async () => {
    server = nodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/elsewhere" });
          response.end();
          return;
        }
        response.setHeader("set-cookie", ["a=1", "b=2"]);
        response.setHeader("x-echo-method", request.method ?? "");
        response.end(
          JSON.stringify({
            url: request.url,
            body,
            header: request.headers["x-test"],
            authorization: request.headers.authorization,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function read(response: InstanceType<typeof http.IncomingMessage>): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve(body));
      response.on("error", reject);
    });
  }

  test("request sends the method, headers and body and streams the response", async () => {
    const response = await new Promise<InstanceType<typeof http.IncomingMessage>>(
      (resolve, reject) => {
        const request = http.request(
          `${base}/path?x=1`,
          { method: "POST", headers: { "X-Test": "yes" }, auth: "user:pass" },
          resolve,
        );
        request.on("error", reject);
        request.write("hello ");
        request.end("world");
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.statusMessage).toBe("OK");
    expect(response.headers["set-cookie"]).toStrictEqual(["a=1", "b=2"]);
    expect(response.headers["x-echo-method"]).toBe("POST");
    expect(JSON.parse(await read(response))).toStrictEqual({
      url: "/path?x=1",
      body: "hello world",
      header: "yes",
      authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
    });
  });

  test("get returns redirects without following them", async () => {
    const response = await new Promise<InstanceType<typeof http.IncomingMessage>>((resolve) =>
      http.get(`${base}/redirect`, resolve),
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/elsewhere");
    response.resume();
  });

  test("errors, protocols and the server stub", async () => {
    const error = await new Promise<Error>((resolve) =>
      http.get("http://127.0.0.1:1/", () => {}).on("error", resolve),
    );
    expect(error).toMatchObject({ code: "ECONNREFUSED" });
    expect(() => http.request("https://example.com/")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_PROTOCOL" }),
    );
    expect(() => https.request("http://example.com/")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_PROTOCOL" }),
    );
    expect(() => http.createServer()).toThrow("http.createServer is not available in fetchlet");
    expect(http.STATUS_CODES).toStrictEqual(nodeHttp.STATUS_CODES);
    expect(http.METHODS).toStrictEqual(nodeHttp.METHODS);
  });
});
