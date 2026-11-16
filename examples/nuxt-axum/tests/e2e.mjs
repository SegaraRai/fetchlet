import assert from "node:assert/strict";
import { exampleSuite } from "../../../tools/testing/example-suite.mjs";

const suite = exampleSuite("nuxt-axum");
const { check } = suite;

check("Nuxt SSR, escaping, runtime config and the Rust service binding", async () => {
  const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & Nuxt>"));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /こんにちは、&lt;Rust &amp; Nuxt&gt;/);
  // useFetch reaches the server route through a nested Nitro fetch.
  assert.match(html, /NuxtとRustへようこそ/);
  assert.match(html, /Rustサービスからの挨拶です/);
});

check("Nuxt JavaScript, CSS and public files", async () => {
  const html = await (await fetch(suite.base)).text();
  const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css))["']/g)]
    .map((match) => new URL(match[1], suite.base))
    .filter((url) => url.pathname.startsWith("/_nuxt/"));
  assert.ok(assets.some((url) => url.pathname.endsWith(".js")));
  assert.ok(assets.some((url) => url.pathname.endsWith(".css")));
  for (const asset of assets) {
    const response = await fetch(asset);
    assert.equal(response.status, 200, asset.href);
    assert.match(
      response.headers.get("content-type"),
      asset.pathname.endsWith(".css") ? /css/ : /javascript/,
    );
  }
  assert.match(await (await fetch(suite.base + "/health.txt")).text(), /nuxt-axum assets/);
  assert.equal((await fetch(suite.base + "/server.js")).status, 404);
});

check("Nitro JSON route", async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), value);
});

check("form post, Set-Cookie and redirect", async () => {
  const response = await fetch(suite.base + "/greet", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "田中" }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/?name=" + encodeURIComponent("田中"));
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /visitor=/);
  const page = await fetch(suite.base, { headers: { cookie: cookie.split(";")[0] } });
  assert.match(await page.text(), /こんにちは、田中/);
});

check("Nitro client address and host bindings", async () => {
  const response = await fetch(suite.base + "/api/context");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    clientAddress: "127.0.0.1",
    message: "NuxtとRustへようこそ。",
  });
});

check("native axum route coexists with Nuxt", async () => {
  const response = await fetch(suite.base + "/api/rust");
  assert.deepEqual(await response.json(), { message: "served by axum" });
});

check("input budget and the following Nuxt request", async () => {
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    body: "x".repeat(4097),
  });
  assert.equal(response.status, 413);
  assert.equal((await fetch(suite.base)).status, 200);
});

// A chunked upload without Content-Length, produced over time.
function upload(chunks, size) {
  const chunk = new Uint8Array(size).fill(97);
  const body = new ReadableStream({
    async start(controller) {
      for (let index = 0; index < chunks; index += 1) {
        controller.enqueue(chunk);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      controller.close();
    },
  });
  return fetch(suite.base + "/api/upload", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
    duplex: "half",
  });
}

check("streamed uploads reach the Nitro route in chunks within the budget", async () => {
  const response = await upload(3, 1000);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.bytes, 3000);
  assert.ok(result.chunks >= 2, `chunks: ${result.chunks}`);

  // Undeclared excess errors the route's body stream.
  const oversized = await upload(5, 1000);
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "LIMIT_EXCEEDED" });
  assert.equal((await fetch(suite.base)).status, 200);
});

check("event.waitUntil work runs after the response and before the next request", async () => {
  const label = "job-" + Date.now();
  const response = await fetch(suite.base + "/api/background", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(accepted.accepted, label);
  assert.ok(!accepted.completed.includes(label), "sent before the work finished");
  const { completed } = await (await fetch(suite.base + "/api/background")).json();
  assert.ok(completed.includes(label));
});

check("concurrent Nuxt requests keep their own values", async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      const html = await (await fetch(suite.base + "/?name=" + name)).text();
      assert.match(html, new RegExp("こんにちは、" + name));
    }),
  );
});

check("hydration, form submission and Nuxt navigation", async () => {
  const page = await suite.page();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(suite.base);
  await page.waitForFunction(
    () => document.querySelector("[data-counter]")?.dataset.hydrated === "true",
  );
  await page.getByRole("button", { name: "クリック 0", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "クリック 1", exact: true }).count(), 1);

  await page.getByLabel("名前").fill("ブラウザ");
  await page.getByRole("button", { name: "挨拶する" }).click();
  await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("ブラウザ"));
  await page.waitForFunction(
    () => document.querySelector("[data-counter]")?.dataset.hydrated === "true",
  );

  await page.evaluate(() => {
    window.fetchletNavigationMarker = "retained";
  });
  await page.getByRole("link", { name: "このページについて" }).click();
  await page.waitForURL("**/about");
  assert.equal(await page.getByRole("heading", { name: "このページについて" }).count(), 1);
  assert.equal(await page.evaluate(() => window.fetchletNavigationMarker), "retained");
  assert.deepEqual(errors, []);
  await page.close();
});
