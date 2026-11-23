// The profile's Body, Request and Response on Node, over the profile's
// Streams provider and Node's URL and encoders. Body.textStream is left to
// the WPT conformance run on the engines (fetch/api/body/textstream.any.js):
// its TextDecoderStream builds on the real global TransformStream, which on
// Node is not the profile's provider.

import { describe, expect, test, vi } from "vite-plus/test";

import { BodyImpl } from "../src/internal/fetch/body.ts";
import { runtime } from "../src/internal/runtime/runtime.ts";
import "../src/internal/foundation/foundation.ts";
import "../src/internal/fetch/form-data.ts";
import "../src/internal/fetch/request.ts";
import "../src/internal/fetch/response.ts";

vi.mock(import("../src/internal/runtime/runtime.ts"), async () => {
  const { fetchGlobals, isolatedRuntime } = await import("./isolated-runtime.ts");
  return isolatedRuntime(fetchGlobals);
});

const Request: typeof globalThis.Request = runtime.Request;
const Response: typeof globalThis.Response = runtime.Response;
const FormData: typeof globalThis.FormData = runtime.FormData;
const Blob: typeof globalThis.Blob = runtime.Blob;
const AbortController: typeof globalThis.AbortController = runtime.AbortController;

const ReadableStream: typeof globalThis.ReadableStream = runtime.ReadableStream;
const bytes = (text: string) => new TextEncoder().encode(text);

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(bytes(chunk));
      }
      controller.close();
    },
  });
}

describe("Body", () => {
  test("these are the profile's classes", () => {
    for (const name of ["Request", "Response", "Headers", "FormData", "Blob"]) {
      expect(runtime[name], name).not.toBe((globalThis as Record<string, unknown>)[name]);
    }
    expect(new Response("x")).toBeInstanceOf(BodyImpl);
  });

  test("sets the content type of strings, URLSearchParams and Blobs", () => {
    expect(new Response("text").headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(new Response(new URLSearchParams("a=1")).headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    expect(new Response(new Blob(["x"], { type: "image/png" })).headers.get("content-type")).toBe(
      "image/png",
    );
    expect(new Response(bytes("x")).headers.get("content-type")).toBeNull();
    const explicit = new Response("x", { headers: { "content-type": "text/html" } });
    expect(explicit.headers.get("content-type")).toBe("text/html");
  });

  test("copies byte bodies when constructed", async () => {
    const source = bytes("abc");
    const response = new Response(source);
    source[0] = 0x78;
    expect(await response.text()).toBe("abc");
    const buffer = bytes("def").buffer;
    const fromBuffer = new Response(buffer);
    new Uint8Array(buffer)[0] = 0x78;
    expect(await fromBuffer.text()).toBe("def");
  });

  test("reads bytes, text, JSON, Blob and streams", async () => {
    expect(await new Response('{"a":1}').json()).toStrictEqual({ a: 1 });
    expect([...(await new Response("hi").bytes())]).toStrictEqual([104, 105]);
    expect(new Uint8Array(await new Response("hi").arrayBuffer())).toStrictEqual(bytes("hi"));
    const blob = await new Response("hi", { headers: { "content-type": "text/x" } }).blob();
    expect([blob.type, await blob.text()]).toStrictEqual(["text/x", "hi"]);
    expect(await new Response(stream(["a", "b", "c"])).text()).toBe("abc");
    expect(await new Response(null).text()).toBe("");
  });

  test("a body reads once, by either path", async () => {
    const response = new Response("once");
    expect(response.bodyUsed).toBe(false);
    await response.text();
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toThrow("Body already consumed or locked");
    // The stream of a body read through bytes is disturbed and locked.
    expect(response.body?.locked).toBe(true);

    const streamed = new Response(stream(["x"]));
    await streamed.text();
    await expect(streamed.arrayBuffer()).rejects.toThrow(TypeError);
  });

  test("body creates one byte stream for buffered bytes", async () => {
    const response = new Response("stream me");
    const body = response.body!;
    expect(response.body).toBe(body);
    expect(response.bodyUsed).toBe(false);
    expect(await new Response(body).text()).toBe("stream me");
    expect(response.bodyUsed).toBe(true);
    expect(new Response(null).body).toBeNull();
  });

  test("a locked or disturbed stream cannot become a body", async () => {
    const locked = stream(["x"]);
    locked.getReader();
    expect(() => new Response(locked)).toThrow("Body stream is unusable");
    const disturbed = stream(["x"]);
    await disturbed.getReader().read();
    expect(() => new Response(disturbed)).toThrow("Body stream is unusable");
  });

  test("a stream chunk that is not bytes fails the read", async () => {
    const strings = new ReadableStream({
      start(controller) {
        controller.enqueue("text");
        controller.close();
      },
    });
    await expect(new Response(strings).text()).rejects.toThrow("Expected byte chunk");
  });

  test("formData parses URL-encoded and multipart bodies", async () => {
    const encoded = await new Response(new URLSearchParams("a=1&a=2&b=x")).formData();
    expect(encoded.getAll("a")).toStrictEqual(["1", "2"]);

    const form = new FormData();
    form.append("field", "value");
    form.append("file", new Blob(["content"], { type: "text/csv" }), "data.csv");
    const response = new Response(form);
    expect(response.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const parsed = await response.formData();
    expect(parsed.get("field")).toBe("value");
    const file = parsed.get("file") as File;
    expect([file.name, file.type, await file.text()]).toStrictEqual([
      "data.csv",
      "text/csv",
      "content",
    ]);
    await expect(new Response("x").formData()).rejects.toThrow("Unsupported form content type");
  });

  test("takeBytesOf hands over unread bytes once", async () => {
    const response = new Response("taken");
    expect(BodyImpl.takeBytesOf(response)).toStrictEqual(bytes("taken"));
    expect(response.bodyUsed).toBe(true);
    expect(BodyImpl.takeBytesOf(response)).toBeUndefined();
    expect(BodyImpl.takeBytesOf(new Response(stream(["x"])))).toBeUndefined();
    expect(BodyImpl.takeBytesOf(new globalThis.Response("node"))).toBeUndefined();
  });

  test("attribute getters check their receiver", () => {
    // eslint-disable-next-line typescript/unbound-method -- the call supplies a foreign receiver
    const getter = Object.getOwnPropertyDescriptor(BodyImpl.prototype, "bodyUsed")!.get!;
    expect(() => getter.call({})).toThrow("Illegal invocation");
  });
});

describe("Response", () => {
  test("validates status, status text and null body statuses", () => {
    expect(() => new Response(null, { status: 199 })).toThrow(RangeError);
    expect(() => new Response(null, { status: 600 })).toThrow(RangeError);
    expect(() => new Response(null, { statusText: "bad\nline" })).toThrow("Invalid status text");
    for (const status of [204, 205, 304]) {
      expect(() => new Response("x", { status })).toThrow("Null body status");
      expect(new Response(null, { status }).status).toBe(status);
    }
    const response = new Response(null, { status: 201, statusText: "Created" });
    expect([response.status, response.statusText, response.ok]).toStrictEqual([
      201,
      "Created",
      true,
    ]);
    expect(new Response(null, { status: 404 }).ok).toBe(false);
  });

  test("json serializes the value with a JSON content type", async () => {
    const response = Response.json({ a: [1] }, { status: 202 });
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"a":[1]}');
    expect(
      Response.json(1, { headers: { "content-type": "text/x" } }).headers.get("content-type"),
    ).toBe("text/x");
    expect(() => Response.json(undefined)).toThrow("Value is not JSON serializable");
  });

  test("redirect parses the location and freezes the headers", () => {
    const response = Response.redirect("https://app.test/a/../b", 307);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://app.test/b");
    expect(() => response.headers.set("x", "1")).toThrow("Headers are immutable");
    expect(() => Response.redirect("https://app.test/", 200)).toThrow(RangeError);
    expect(() => Response.redirect("/relative")).toThrow(TypeError);
  });

  test("error is a network error with frozen headers", () => {
    const response = Response.error();
    expect([response.status, response.type]).toStrictEqual([0, "error"]);
    expect(() => response.headers.append("x", "1")).toThrow("Headers are immutable");
    const clone = response.clone();
    expect([clone.status, clone.type]).toStrictEqual([0, "error"]);
    expect(() => clone.headers.append("x", "1")).toThrow("Headers are immutable");
  });

  test("clone gives each branch the whole body", async () => {
    const buffered = new Response("both");
    const bufferedClone = buffered.clone();
    expect([await buffered.text(), await bufferedClone.text()]).toStrictEqual(["both", "both"]);

    const streamed = new Response(stream(["a", "b"]), { status: 201 });
    const streamedClone = streamed.clone();
    expect(streamedClone.status).toBe(201);
    expect([await streamedClone.text(), await streamed.text()]).toStrictEqual(["ab", "ab"]);

    const used = new Response("x");
    await used.text();
    expect(() => used.clone()).toThrow("Cannot clone consumed body");
  });
});

describe("Request", () => {
  test("defaults and normalizes the method", () => {
    const request = new Request("https://app.test/path");
    expect([request.method, request.url, request.mode, request.credentials]).toStrictEqual([
      "GET",
      "https://app.test/path",
      "cors",
      "same-origin",
    ]);
    expect(new Request("https://app.test/", { method: "post" }).method).toBe("POST");
    expect(new Request("https://app.test/", { method: "patch" }).method).toBe("patch");
  });

  test("refuses invalid and forbidden methods, credentials and GET bodies", () => {
    expect(() => new Request("https://app.test/", { method: "bad method" })).toThrow(
      "Invalid request method",
    );
    for (const method of ["CONNECT", "trace", "TRACK"]) {
      expect(() => new Request("https://app.test/", { method }), method).toThrow(
        "Invalid request method",
      );
    }
    expect(() => new Request("https://user:pass@app.test/")).toThrow(
      "Request URL contains credentials",
    );
    // eslint-disable-next-line unicorn/no-invalid-fetch-options -- the invalid body is the case
    expect(() => new Request("https://app.test/", { body: "x" })).toThrow("GET/HEAD body");
    // eslint-disable-next-line unicorn/no-invalid-fetch-options -- the invalid body is the case
    expect(() => new Request("https://app.test/", { method: "HEAD", body: "x" })).toThrow(
      "GET/HEAD body",
    );
    expect(() => new Request("/relative")).toThrow(TypeError);
  });

  test("validates enumerations and refuses navigate requests", () => {
    expect(() => new Request("https://app.test/", { mode: "navigate" })).toThrow(
      "Cannot construct a navigate request",
    );
    expect(() => new Request("https://app.test/", { redirect: "sometimes" as never })).toThrow(
      "Invalid RequestInit redirect: sometimes",
    );
    expect(
      () => new Request("https://app.test/", { cache: "only-if-cached", mode: "cors" }),
    ).toThrow("only-if-cached requires same-origin mode");
  });

  test("a request built from another keeps its fields and body", async () => {
    const original = new Request("https://app.test/", {
      method: "PUT",
      body: "payload",
      headers: { "x-a": "1" },
      redirect: "manual",
      keepalive: true,
    });
    const copy = new Request(original);
    expect([copy.method, copy.redirect, copy.keepalive, copy.headers.get("x-a")]).toStrictEqual([
      "PUT",
      "manual",
      true,
      "1",
    ]);
    expect(await copy.text()).toBe("payload");
    const overridden = new Request(original, { method: "POST", body: "other" });
    expect([overridden.method, await overridden.text()]).toStrictEqual(["POST", "other"]);
  });

  test("the signal follows the init signal", () => {
    const controller = new AbortController();
    const request = new Request("https://app.test/", { signal: controller.signal });
    expect(request.signal.aborted).toBe(false);
    expect(request.signal).not.toBe(controller.signal);
    controller.abort("stop");
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe("stop");
    expect(() => new Request("https://app.test/", { signal: {} as never })).toThrow(
      "Expected AbortSignal",
    );
  });

  test("clone copies the body and follows the original's signal", async () => {
    const controller = new AbortController();
    const request = new Request("https://app.test/", {
      method: "POST",
      body: stream(["a", "b"]),
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    const clone = request.clone();
    expect([await clone.text(), await request.text()]).toStrictEqual(["ab", "ab"]);
    controller.abort();
    expect(clone.signal.aborted).toBe(true);
  });
  test("a ReadableStream body needs duplex, no keepalive and a cors mode", () => {
    const init = { method: "POST", body: stream(["a"]) };
    expect(() => new Request("https://app.test/", init)).toThrow(TypeError);
    expect(
      () =>
        new Request("https://app.test/", {
          ...init,
          duplex: "half",
          keepalive: true,
        } as RequestInit),
    ).toThrow(TypeError);
    expect(
      () =>
        new Request("https://app.test/", {
          ...init,
          duplex: "half",
          mode: "no-cors",
        } as RequestInit),
    ).toThrow(TypeError);
    // Bytes have a source, so they need none of this.
    expect(
      new Request("https://app.test/", { method: "POST", body: "a", keepalive: true }).keepalive,
    ).toBe(true);
  });

  test("the host learns which bodies stream, through clones and copies", () => {
    const streams = (
      runtime as { __fetchletStreamsBody: (request: unknown) => boolean | undefined }
    ).__fetchletStreamsBody;
    const streamed = new Request("https://app.test/", {
      method: "POST",
      body: stream(["a"]),
      duplex: "half",
    } as RequestInit);
    expect(streams(streamed)).toBe(true);
    expect(streams(streamed.clone())).toBe(true);
    expect(streams(new Request(streamed))).toBe(true);
    const blob = new Request("https://app.test/", { method: "POST", body: new Blob(["a"]) });
    expect(streams(blob)).toBe(false);
    expect(streams(blob.clone())).toBe(false);
    expect(streams(new Request("https://app.test/"))).toBe(false);
    expect(streams({})).toBeUndefined();
  });
});
