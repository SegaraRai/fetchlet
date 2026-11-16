promise_test(async (t) => {
  const data = new Uint8Array([1, 2]);
  const response = new Response(data);
  data[0] = 9;
  assert_array_equals(await response.bytes(), [1, 2]);
}, "Response snapshots a typed-array body");

promise_test(async (t) => {
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

promise_test(async (t) => {
  const response = new Response(null);
  assert_equals(await response.text(), "");
  assert_false(response.bodyUsed);
  assert_equals(await response.text(), "");
  assert_equals(await response.clone().text(), "");
}, "A null body remains usable after consumption");

promise_test(async (t) => {
  const response = new Response("text");
  await response.body.cancel();
  assert_true(response.bodyUsed);
  assert_throws_js(TypeError, () => response.clone());
}, "Cancelling the exposed stream disturbs Body");

promise_test(async (t) => {
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

promise_test(async (t) => {
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

promise_test(async (t) => {
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
    if (done) break;
    text += value;
  }
  assert_equals(text, "あ");
}, "TextDecoderStream retains a multibyte character across chunks");
