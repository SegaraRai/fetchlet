promise_test(async () => {
  const data = new Uint8Array([1, 2]);
  const response = new Response(data);
  data[0] = 9;
  assert_array_equals(await response.bytes(), [1, 2]);
}, "Response snapshots a typed-array body");

promise_test(async () => {
  const response = new Response("abc");
  const reader = response.body.getReader();
  assert_false(response.bodyUsed);
  await reader.read();
  assert_true(response.bodyUsed);
  while (!(await reader.read()).done) {}
  reader.releaseLock();
  await promise_rejects_js(t, TypeError, response.text());
  assert_throws_js(TypeError, () => response.clone());
}, "Direct reader consumption disturbs Body and prevents later consumption");

promise_test(async () => {
  const response = new Response(null);
  assert_equals(await response.text(), "");
  assert_false(response.bodyUsed);
  assert_equals(await response.text(), "");
  assert_equals(await response.clone().text(), "");
}, "A null body remains usable after consumption");

promise_test(async () => {
  const response = new Response("text");
  await response.body.cancel();
  assert_true(response.bodyUsed);
  assert_throws_js(TypeError, () => response.clone());
}, "Cancelling the exposed stream disturbs Body");

promise_test(async () => {
  const response = new Response("text");
  const copy = response.clone();
  assert_false(response.bodyUsed);
  assert_false(copy.bodyUsed);
  assert_array_equals(await Promise.all([response.text(), copy.text()]), ["text", "text"]);
}, "Clone branches have independent disturbed state");

test(() => {
  const headers = new Headers({ "x-value": "\u00a0value\u00a0" });
  assert_equals(headers.get("x-value"), "\u00a0value\u00a0");
  assert_throws_js(TypeError, () => headers.set("x-value", "a\nb"));
  assert_equals(headers.get("x-value"), "\u00a0value\u00a0");
}, "Header normalization preserves non-HTTP whitespace and failed set is atomic");

test(() => {
  const response = Response.redirect("https://example.com", 302);
  assert_throws_js(TypeError, () => response.headers.set("x", "value"));
  assert_throws_js(TypeError, () => response.clone().headers.delete("location"));
  assert_throws_js(RangeError, () => Response.redirect("https://example.com", 200));
}, "Redirect response validation and immutable headers");

test(() => {
  assert_throws_js(TypeError, () => new Request("https://example.com", { method: "CONNECT" }));
  assert_equals(new Request("https://example.com", { method: "custom" }).method, "custom");
  assert_throws_js(TypeError, () => new Request("https://user:pass@example.com"));
}, "Request methods and credential URLs");

test(() => {
  const controller = new AbortController();
  const request = new Request("https://example.com", { signal: controller.signal });
  assert_not_equals(request.signal, controller.signal);
  controller.abort("reason");
  assert_true(request.signal.aborted);
  assert_equals(request.signal.reason, "reason");
}, "Request has a dependent signal");

test(() => {
  assert_equals(new Response(null, { status: 201.9 }).status, 201);
  assert_throws_js(TypeError, () => Response.json(undefined));
  assert_equals(Response.error().status, 0);
}, "Response status conversion and static methods");

promise_test(async () => {
  const blob = new Blob([new Uint8Array([1, 2])], { type: "text/日" });
  assert_equals(blob.type, "");
  const first = await blob.bytes();
  first[0] = 9;
  assert_array_equals(await blob.bytes(), [1, 2]);
}, "Blob normalizes type and returns independent byte arrays");

test(() => {
  const data = new FormData();
  data.append("a", "first");
  data.append("b", "second");
  data.append("a", "third");
  data.set("a", "replacement");
  assert_array_equals([...data.keys()], ["a", "b"]);
  assert_array_equals(data.getAll("a"), ["replacement"]);
}, "FormData.set preserves the first entry position");

promise_test(async () => {
  const response = new Response("not multipart", {
    headers: { "content-type": "multipart/form-data; boundary=example" },
  });
  await promise_rejects_js(t, TypeError, response.formData());
}, "Malformed multipart without a closing boundary rejects");

test(() => {
  assert_throws_js(TypeError, () =>
    new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([255])),
  );
  assert_equals(new TextDecoder().decode(new Uint8Array([239, 187, 191, 65])), "A");
  assert_equals(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([239, 187, 191, 65])),
    "\uFEFFA",
  );
  assert_array_equals(new TextEncoder().encode("\uD800"), [239, 191, 189]);
}, "Encoding handles fatal UTF-8, BOM and unmatched surrogates");

promise_test(async () => {
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([227]));
      controller.enqueue(new Uint8Array([129, 130]));
      controller.close();
    },
  });
  const reader = input.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += value;
  }
  assert_equals(text, "あ");
}, "TextDecoderStream retains a multibyte character across chunks");

function multipartResponse(body, type = "multipart/form-data; boundary=b0") {
  return new Response(body, { headers: { "content-type": type } });
}

promise_test(async () => {
  const body =
    'preamble\r\n--b0\r\nContent-Disposition: form-data; name="a"\r\n\r\n' +
    "x\r\n\r\ny-\r\n" +
    '\r\n--b0\r\ncontent-disposition: FORM-DATA; NAME="b"\r\n\r\n\r\n--b0--\r\nepilogue';
  const form = await multipartResponse(body).formData();
  assert_array_equals([...form.keys()], ["a", "b"]);
  assert_equals(form.get("a"), "x\r\n\r\ny-\r\n");
  assert_equals(form.get("b"), "");
}, "multipart keeps blank lines in content and ignores a preamble and epilogue");

promise_test(async () => {
  const form = new FormData();
  form.append('名前 "q"\r\n', "値");
  form.append("file", new File(["a\r\nb"], 'ファイル".txt', { type: "text/csv" }));
  const parsed = await new Response(form).formData();
  assert_array_equals([...parsed.keys()], ['名前 "q"\r\n', "file"]);
  assert_equals(parsed.get('名前 "q"\r\n'), "値");
  const file = parsed.get("file");
  assert_equals(file.name, 'ファイル".txt');
  assert_equals(file.type, "text/csv");
  assert_equals(await file.text(), "a\r\nb");
}, "multipart round-trips UTF-8 and escaped names, filenames and CRLF content");

promise_test(async () => {
  const body = '--a;b\r\nContent-Disposition: form-data; name="f"; filename=""\r\n\r\nz\r\n--a;b--';
  const form = await multipartResponse(body, 'Multipart/Form-Data; Boundary="a;b"').formData();
  const file = form.get("f");
  assert_true(file instanceof File);
  assert_equals(file.name, "");
  assert_equals(file.type, "text/plain");
}, "multipart parses quoted boundaries case-insensitively and defaults file types");

promise_test(async () => {
  const part = '--b0\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n';
  for (const body of [
    part,
    "--b0\r\nContent-Type: text/plain\r\n\r\nv\r\n--b0--",
    '--b0\r\nContent-Disposition: attachment; name="a"\r\n\r\nv\r\n--b0--',
    '--b0\r\nContent-Disposition: form-data; filename="a"\r\n\r\nv\r\n--b0--',
    '--b0junk\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--b0--',
    '--b0\r\nContent-Disposition: form-data; name="a"\r\nv\r\n--b0--',
    '--b0\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--b0z\r\n--b0--',
    "no delimiter",
  ]) {
    await promise_rejects_js(
      t,
      TypeError,
      multipartResponse(body).formData(),
      JSON.stringify(body),
    );
  }
  await promise_rejects_js(
    t,
    TypeError,
    multipartResponse(part + "--b0--", "multipart/form-data").formData(),
  );
}, "malformed multipart bodies and missing boundaries are TypeErrors");

test(() => {
  const names = [
    "method",
    "url",
    "headers",
    "destination",
    "referrer",
    "referrerPolicy",
    "mode",
    "credentials",
    "cache",
    "redirect",
    "integrity",
    "keepalive",
    "isReloadNavigation",
    "isHistoryNavigation",
    "signal",
    "body",
    "bodyUsed",
    "duplex",
  ];
  const request = new Request("https://example.test/");
  for (const name of names) {
    assert_false(Object.hasOwn(request, name), name + " is not an own property");
    let prototype = Request.prototype;
    let descriptor;
    while (prototype && !(descriptor = Object.getOwnPropertyDescriptor(prototype, name))) {
      prototype = Object.getPrototypeOf(prototype);
    }
    assert_equals(typeof descriptor?.get, "function", name + " getter");
    // Reading the setter off the descriptor is the check, not a method call.
    // eslint-disable-next-line typescript/unbound-method
    assert_equals(descriptor.set, undefined, name + " is read-only");
    assert_true(descriptor.enumerable, name + " is enumerable");
    assert_throws_js(TypeError, () => descriptor.get.call({}), name + " brand check");
  }
  assert_equals(request.destination, "");
  assert_equals(request.referrer, "about:client");
  assert_equals(request.referrerPolicy, "");
  assert_equals(request.mode, "cors");
  assert_equals(request.credentials, "same-origin");
  assert_equals(request.cache, "default");
  assert_equals(request.integrity, "");
  assert_false(request.keepalive);
  assert_false(request.isReloadNavigation);
  assert_false(request.isHistoryNavigation);
  assert_equals(request.duplex, "half");
}, "Request exposes its Web IDL attributes as read-only prototype accessors");

test(() => {
  const init = {
    method: "post",
    referrer: "https://referrer.test/page",
    referrerPolicy: "no-referrer",
    mode: "same-origin",
    credentials: "include",
    cache: "only-if-cached",
    redirect: "manual",
    integrity: "sha256-abc",
    keepalive: 1,
  };
  const request = new Request("https://example.test/", init);
  const copies = [request.clone(), new Request(request)];
  for (const copy of [request, ...copies]) {
    assert_equals(copy.method, "POST");
    assert_equals(copy.referrer, "https://referrer.test/page");
    assert_equals(copy.referrerPolicy, "no-referrer");
    assert_equals(copy.mode, "same-origin");
    assert_equals(copy.credentials, "include");
    assert_equals(copy.cache, "only-if-cached");
    assert_equals(copy.redirect, "manual");
    assert_equals(copy.integrity, "sha256-abc");
    assert_true(copy.keepalive);
  }
  const reset = new Request(request, { method: "PUT" });
  assert_equals(reset.referrer, "about:client");
  assert_equals(reset.referrerPolicy, "");
  assert_equals(reset.mode, "same-origin");
  assert_equals(new Request(request, { referrer: "" }).referrer, "");
}, "Request copies its attributes and resets referrer fields for a non-empty init");

test(() => {
  const url = "https://example.test/";
  for (const [member, value] of [
    ["mode", "navigate"],
    ["mode", "other"],
    ["credentials", "other"],
    ["cache", "other"],
    ["redirect", "other"],
    ["referrerPolicy", "other"],
    ["priority", "other"],
    ["duplex", "full"],
    ["referrer", "not a url"],
  ]) {
    assert_throws_js(TypeError, () => new Request(url, { [member]: value }), member + "=" + value);
  }
  assert_throws_js(TypeError, () => new Request(url, { cache: "only-if-cached" }));
  assert_equals(new Request(url, { priority: "high" }).url, url);
}, "Request validates RequestInit enumerations and mode constraints");

promise_test(async () => {
  const response = new Response("abc");
  assert_equals(await response.text(), "abc");
  assert_true(response.bodyUsed);
  const stream = response.body;
  assert_not_equals(stream, null);
  assert_true(stream.locked, "a fully read body stays locked");
  assert_equals(response.body, stream);
  await promise_rejects_js(t, TypeError, response.text());
  assert_throws_js(TypeError, () => response.clone());
}, "Reading a byte body without its stream leaves the Body used and its stream locked");

promise_test(async () => {
  const response = new Response("abc");
  const stream = response.body;
  assert_equals(response.body, stream, "body returns one stream");
  assert_false(response.bodyUsed);
  assert_equals(await response.text(), "abc");
  assert_true(response.bodyUsed);
  assert_equals(response.body, stream);
  await promise_rejects_js(t, TypeError, response.text());
}, "A byte body read after exposing its stream uses that stream");

promise_test(async () => {
  const response = new Response(new Uint8Array([1, 2, 3]));
  const copy = response.clone();
  const first = new Uint8Array(await response.arrayBuffer());
  first[0] = 9;
  assert_array_equals(new Uint8Array(await copy.arrayBuffer()), [1, 2, 3]);
  assert_true(copy.bodyUsed);
}, "Clones of a byte body read independent buffers");

promise_test(async () => {
  const response = new Response("");
  assert_not_equals(response.body, null);
  const empty = new Response("");
  assert_equals(await empty.text(), "");
  assert_true(empty.bodyUsed);
  await promise_rejects_js(t, TypeError, empty.arrayBuffer());
}, "An empty byte body is a non-null body that can be read once");

promise_test(async () => {
  // eslint-disable-next-line unicorn/no-invalid-fetch-options -- the invalid body is the case
  assert_throws_js(TypeError, () => new Request("https://example.test/", { body: "x" }));
  const request = new Request("https://example.test/", { method: "POST", body: "payload" });
  assert_equals(request.headers.get("content-type"), "text/plain;charset=UTF-8");
  const copy = request.clone();
  assert_equals(await request.text(), "payload");
  assert_equals(await copy.text(), "payload");
  const reader = new Request("https://example.test/", {
    method: "POST",
    body: "chunk",
  }).body.getReader();
  const { value } = await reader.read();
  assert_equals(new TextDecoder().decode(value), "chunk");
  assert_true((await reader.read()).done);
}, "Request byte bodies keep GET/HEAD checks, clone and stream reads");

test(() => {
  const url = new URL("https://example.test/path?a=1&b=2#frag");
  const params = url.searchParams;
  assert_equals(url.searchParams, params, "searchParams is the same object");
  assert_true(params instanceof URLSearchParams);
  params.append("c", "3 4");
  assert_equals(url.search, "?a=1&b=2&c=3+4");
  params.delete("a");
  params.set("b", "x");
  assert_equals(url.href, "https://example.test/path?b=x&c=3+4#frag");
  params.delete("b");
  params.delete("c");
  assert_equals(url.search, "");
  assert_equals(url.href, "https://example.test/path#frag", "an empty list removes the query");
}, "URL searchParams changes update the URL's query");

test(() => {
  const url = new URL("https://example.test/?a=1");
  const params = url.searchParams;
  url.search = "?x=1&x=2";
  assert_array_equals(params.getAll("x"), ["1", "2"]);
  assert_false(params.has("a"));
  url.href = "https://example.test/?y=3";
  assert_equals(params.get("y"), "3");
  assert_false(params.has("x"));
  params.sort();
  assert_equals(url.search, "?y=3");
}, "URL query changes replace the searchParams list");

test(() => {
  assert_true(URL.canParse("/a", "https://example.test/"));
  assert_false(URL.canParse("/a"));
  assert_equals(URL.parse("/a"), null);
  const parsed = URL.parse("b?c", "https://example.test/a/");
  assert_true(parsed instanceof URL);
  assert_equals(parsed.href, "https://example.test/a/b?c");
  assert_throws_js(TypeError, () => URL.parse(Symbol("url")));
  assert_throws_js(TypeError, () => new URL("/relative"));
  assert_throws_js(TypeError, () => URL.canParse());
}, "URL.parse and URL.canParse return failure without throwing, after argument conversion");

test(() => {
  const url = new URL("https://user:pass@example.test:8080/p?q#h");
  assert_equals(JSON.stringify({ url }), '{"url":"https://user:pass@example.test:8080/p?q#h"}');
  assert_equals(String(url), url.href);
  assert_equals(Object.prototype.toString.call(url), "[object URL]");
  for (const name of ["href", "origin", "protocol", "host", "port", "search", "searchParams"]) {
    const descriptor = Object.getOwnPropertyDescriptor(URL.prototype, name);
    assert_true(descriptor.enumerable, name + " is enumerable");
    assert_equals(typeof descriptor.get, "function", name + " getter");
    assert_false(Object.hasOwn(url, name), name + " is not an own property");
  }
  assert_throws_js(TypeError, () =>
    Object.getOwnPropertyDescriptor(URL.prototype, "href").get.call({}),
  );
  url.port = "not a port";
  assert_equals(url.port, "8080", "an invalid port is ignored");
  assert_throws_js(TypeError, () => {
    url.href = "not a url";
  });
  assert_equals(url.href, "https://user:pass@example.test:8080/p?q#h");
}, "URL attributes are Web IDL accessors with the standard setter failure modes");

test(() => {
  const url = new URL("https://example.test/\uD800?\uDC00");
  assert_equals(url.pathname, "/%EF%BF%BD");
  assert_equals(url.search, "?%EF%BF%BD");
  assert_equals(new URL("blob:https://example.test:8443/id").origin, "https://example.test:8443");
  assert_equals(new URL("blob:ws://example.test/").origin, "null");
}, "URL converts lone surrogates and derives blob: origins from http(s) paths");
