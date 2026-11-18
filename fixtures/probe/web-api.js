// Run the same behavioral checks after installing each backend's Web API globals.
// This file performs no network requests and starts no HTTP listener.
globalThis.fetchletProbe = async function fetchletProbe(options = {}) {
  const checks = [];
  const equal = (actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const rejects = async (operation) => {
    let rejected = false;
    try {
      await operation();
    } catch {
      rejected = true;
    }
    assert(rejected, "Expected rejection");
  };
  const check = async (id, operation) => {
    let timer;
    try {
      const result = Promise.resolve().then(operation);
      if (typeof globalThis.setTimeout === "function") {
        await Promise.race([
          result,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Probe timed out")),
              options.timeoutMs ?? 2000,
            );
          }),
        ]);
      } else {
        await result;
      }
      checks.push({ id, status: "pass" });
    } catch (error) {
      checks.push({ id, status: "fail", error: String(error?.stack ?? error) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const globals = {};
  for (const name of [
    "Request",
    "Response",
    "Headers",
    "URL",
    "URLSearchParams",
    "URLPattern",
    "FormData",
    "Blob",
    "File",
    "ReadableStream",
    "WritableStream",
    "TransformStream",
    "TextEncoder",
    "TextDecoder",
    "TextEncoderStream",
    "TextDecoderStream",
    "CompressionStream",
    "DecompressionStream",
    "AbortController",
    "AbortSignal",
    "DOMException",
    "Event",
    "EventTarget",
    "CustomEvent",
    "fetch",
    "setTimeout",
    "setInterval",
    "reportError",
    "navigator",
    "queueMicrotask",
    "structuredClone",
    "crypto",
    "CompressionStream",
    "DecompressionStream",
  ])
    globals[name] = typeof globalThis[name];

  await check("request-properties", () => {
    const req = new Request("https://fetchlet.invalid/path?a=1", {
      method: "POST",
      headers: { "x-probe": "ok" },
      body: "hello",
    });
    equal(
      [req.method, req.url, req.headers.get("x-probe")],
      ["POST", "https://fetchlet.invalid/path?a=1", "ok"],
    );
  });
  await check("url-search-params-live", () => {
    const url = new URL("https://fetchlet.invalid/?a=1&a=2");
    equal(url.searchParams.getAll("a"), ["1", "2"]);
    url.searchParams.append("b", "日本語");
    equal(new URL(url.href).searchParams.get("b"), "日本語");
  });
  await check("response-text-status-headers", async () => {
    const res = new Response("日本語", { status: 201, headers: { "x-probe": "ok" } });
    equal([res.status, res.headers.get("x-probe"), await res.text()], [201, "ok", "日本語"]);
  });
  await check("response-json-static", async () => {
    const res = Response.json({ hello: "world" }, { status: 202 });
    equal(res.status, 202);
    assert(res.headers.get("content-type").includes("application/json"), "JSON content type");
    equal(await res.json(), { hello: "world" });
  });
  await check("response-binary-array-buffer", async () => {
    const res = new Response(new Uint8Array([0, 128, 255]));
    equal(Array.from(new Uint8Array(await res.arrayBuffer())), [0, 128, 255]);
  });
  await check("response-body-used-and-double-read", async () => {
    const res = new Response("hello");
    equal(res.bodyUsed, false);
    await res.text();
    equal(res.bodyUsed, true);
    await rejects(() => res.text());
  });
  await check("response-clone-and-header-independence", async () => {
    const res = new Response("hello", { headers: { "x-probe": "original" } });
    const clone = res.clone();
    clone.headers.set("x-probe", "clone");
    equal(res.headers.get("x-probe"), "original");
    equal(await Promise.all([res.text(), clone.text()]), ["hello", "hello"]);
  });
  await check("request-json-clone-and-double-read", async () => {
    const req = new Request("https://fetchlet.invalid/", { method: "POST", body: '{"a":1}' });
    const clone = req.clone();
    equal(await req.json(), { a: 1 });
    equal(req.bodyUsed, true);
    equal(await clone.text(), '{"a":1}');
    await rejects(() => req.text());
  });
  await check("headers-set-cookie-preserved", () => {
    const cookies = ["a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT", "b=2; HttpOnly"];
    const headers = new Headers();
    cookies.forEach((value) => headers.append("set-cookie", value));
    equal(headers.getSetCookie(), cookies);
  });
  await check("form-data-duplicates-first-value", () => {
    const data = new FormData();
    data.append("a", "first");
    data.append("a", "second");
    equal(data.get("a"), "first");
    equal(data.getAll("a"), ["first", "second"]);
  });
  await check("request-urlencoded-form-data", async () => {
    const req = new Request("https://fetchlet.invalid/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=first&a=second&name=%E6%97%A5%E6%9C%AC%E8%AA%9E",
    });
    const data = await req.formData();
    assert(data instanceof FormData, "Expected FormData");
    equal(data.getAll("a"), ["first", "second"]);
    equal(data.get("name"), "日本語");
  });
  await check("request-multipart-file-roundtrip", async () => {
    const data = new FormData();
    data.append("name", "日本語");
    data.append(
      "file",
      new File([new Uint8Array([0, 10, 128, 255])], "a.bin", {
        type: "application/octet-stream",
      }),
    );
    const req = new Request("https://fetchlet.invalid/", { method: "POST", body: data });
    const parsed = await req.formData();
    equal(parsed.get("name"), "日本語");
    const file = parsed.get("file");
    assert(file instanceof File, "Expected File");
    equal(file.name, "a.bin");
    equal(Array.from(new Uint8Array(await file.arrayBuffer())), [0, 10, 128, 255]);
  });
  await check("readable-response-body", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([65, 66]));
        controller.close();
      },
    });
    const res = new Response(body);
    assert(res.body instanceof ReadableStream, "Response.body must be a ReadableStream");
    equal(await res.text(), "AB");
  });
  await check("response-clone-stream-tee", async () => {
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([65]));
          controller.close();
        },
      }),
    );
    const clone = res.clone();
    equal(await Promise.all([res.text(), clone.text()]), ["A", "A"]);
  });
  await check("transform-stream-read-write", async () => {
    const transform = new TransformStream({
      transform(value, controller) {
        controller.enqueue(value + 1);
      },
    });
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const [chunk] = await Promise.all([reader.read(), writer.write(41)]);
    equal([chunk.value, chunk.done], [42, false]);
    const [end] = await Promise.all([reader.read(), writer.close()]);
    equal(end.done, true);
    reader.releaseLock();
    writer.releaseLock();
  });
  await check("readable-cancel-propagates", async () => {
    let cancelled;
    const res = new Response(
      new ReadableStream({
        cancel(reason) {
          cancelled = reason;
        },
      }),
    );
    await res.body.cancel("stop");
    equal(cancelled, "stop");
  });
  await check("text-encoding-roundtrip", () => {
    equal(new TextDecoder().decode(new TextEncoder().encode("日本語😀")), "日本語😀");
  });
  await check("text-encoder-stream", async () => {
    const input = new ReadableStream({
      start(c) {
        c.enqueue("日本語");
        c.close();
      },
    });
    equal(await new Response(input.pipeThrough(new TextEncoderStream())).text(), "日本語");
  });
  await check("abort-controller-request", () => {
    const controller = new AbortController();
    const req = new Request("https://fetchlet.invalid/", { signal: controller.signal });
    controller.abort("stop");
    equal([req.signal.aborted, req.signal.reason], [true, "stop"]);
  });
  await check("timers-and-microtasks", async () => {
    const order = [];
    await new Promise((resolve) => {
      queueMicrotask(() => order.push("microtask"));
      setTimeout(() => {
        order.push("timer");
        resolve();
      }, 0);
    });
    equal(order, ["microtask", "timer"]);
  });
  await check("interval-repeats-until-cleared", async () => {
    let count = 0;
    await new Promise((resolve) => {
      const id = setInterval(() => {
        count += 1;
        if (count === 3) {
          clearInterval(id);
          setTimeout(resolve, 20);
        }
      }, 1);
    });
    equal(count, 3);
  });
  await check("event-target-dispatch", () => {
    const target = new EventTarget();
    const seen = [];
    const listener = (event) => seen.push([event.type, event.detail, event.target === target]);
    target.addEventListener("ping", listener, { once: true });
    target.addEventListener("ping", { handleEvent: () => seen.push("object") });
    target.addEventListener("ping", (event) => event.preventDefault());
    const event = new CustomEvent("ping", { cancelable: true, detail: 42 });
    equal(target.dispatchEvent(event), false);
    target.dispatchEvent(new CustomEvent("ping", { detail: 7 }));
    equal(seen, [["ping", 42, true], "object", "object"]);
    equal([event.defaultPrevented, event.eventPhase, event.currentTarget], [true, 0, null]);
  });
  await check("abort-signal-is-event-target", () => {
    const controller = new AbortController();
    const order = [];
    controller.signal.onabort = (event) => order.push(["handler", event.type, event.isTrusted]);
    controller.signal.addEventListener("abort", () => order.push("listener"));
    controller.abort();
    equal(controller.signal instanceof EventTarget, true);
    equal(order, [["handler", "abort", true], "listener"]);
  });
  await check("navigator-user-agent-and-report-error", () => {
    equal(typeof navigator.userAgent, "string");
    equal(typeof reportError, "function");
  });
  await check("structured-clone-cycle-and-bytes", () => {
    const original = { bytes: new Uint8Array([0, 255]) };
    original.self = original;
    const copy = structuredClone(original);
    assert(copy !== original && copy.self === copy, "Cycle must be cloned");
    original.bytes[0] = 1;
    equal(Array.from(copy.bytes), [0, 255]);
  });
  await check("webcrypto-digest", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    equal(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  await check("webcrypto-ecdsa-sign-verify", async () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
    equal([pair.publicKey.usages, pair.privateKey.usages], [["verify"], ["sign"]]);
    const data = new TextEncoder().encode("fetchlet");
    const signature = await crypto.subtle.sign(algorithm, pair.privateKey, data);
    equal(await crypto.subtle.verify(algorithm, pair.publicKey, signature, data), true);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    equal([jwk.kty, jwk.crv, jwk.alg, jwk.ext], ["EC", "P-256", undefined, true]);
  });
  await check("webcrypto-pbkdf2-aes-gcm", async () => {
    const encoder = new TextEncoder();
    const password = await crypto.subtle.importKey(
      "raw",
      encoder.encode("secret"),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode("salt"), iterations: 1000 },
      password,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    equal([key.algorithm.name, key.algorithm.length, key.extractable], ["AES-GCM", 256, false]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode("fetchlet"),
    );
    equal(sealed.byteLength, 8 + 16);
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed);
    equal(new TextDecoder().decode(opened), "fetchlet");
    await rejects(() => crypto.subtle.exportKey("raw", key));
  });
  await check("compression-gzip-round-trip", async () => {
    const text = "fetchlet ".repeat(100);
    const compressed = new Response(text).body.pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
    equal([bytes[0], bytes[1]], [0x1f, 0x8b]);
    assert(bytes.length < text.length, "Expected compressed output to be smaller");
    const restored = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"));
    equal(await new Response(restored).text(), text);
  });
  await check("url-pattern-match", () => {
    const pattern = new URLPattern({ pathname: "/books/:id(\\d+)" });
    const match = pattern.exec("https://fetchlet.invalid/books/42?x=1");
    equal([match.pathname.groups.id, match.search.input], ["42", "x=1"]);
    equal(pattern.test("https://fetchlet.invalid/books/x"), false);
  });
  await check("synthetic-fetch-handler", async () => {
    const handler = async (request) =>
      new Response(`<p>${new URL(request.url).searchParams.get("name")}</p>`, {
        status: 201,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    const response = await handler(new Request("https://fetchlet.invalid/?name=fetchlet"));
    equal([response.status, await response.text()], [201, "<p>fetchlet</p>"]);
  });

  return {
    schemaVersion: 1,
    runtimeLabel: options.runtimeLabel ?? "unspecified",
    globals,
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "pass").length,
      failed: checks.filter((check) => check.status === "fail").length,
    },
  };
};
