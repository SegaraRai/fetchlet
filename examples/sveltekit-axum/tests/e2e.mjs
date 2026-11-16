import assert from "node:assert/strict";
import { exampleSuite } from "../../../tools/testing/example-suite.mjs";

const suite = exampleSuite("sveltekit-axum");
const { check } = suite;

check("SSR, escaping and the Rust service binding", async () => {
  const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & Svelte>"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /&lt;Rust &amp; Svelte>/);
  assert.match(html, /SvelteKitとRustへようこそ/);
  assert.match(html, /Rustサービスからの挨拶です/);
});

check("client JavaScript, CSS and static files", async () => {
  const html = await (await fetch(suite.base)).text();
  const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css))["']/g)]
    .map((match) => new URL(match[1], suite.base))
    .filter((url) => url.pathname.startsWith("/_app/"));
  assert.ok(assets.some((url) => url.pathname.endsWith(".js")));
  assert.ok(assets.some((url) => url.pathname.endsWith(".css")));
  for (const asset of assets) {
    const response = await fetch(asset);
    assert.equal(response.status, 200, asset.href);
    assert.match(
      response.headers.get("content-type"),
      asset.pathname.endsWith(".css") ? /css/ : /javascript/,
    );
    assert.ok((await response.text()).length > 0);
  }
  assert.match(await (await fetch(suite.base + "/health.txt")).text(), /sveltekit-axum assets/);
  assert.equal((await fetch(suite.base + "/server.js")).status, 404);
});

check("SvelteKit JSON endpoint", async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), value);
});

check("form action and Set-Cookie", async () => {
  const response = await fetch(suite.base, {
    method: "POST",
    headers: {
      origin: suite.base,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: "田中" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /visitor=/);
  assert.match(await response.text(), /田中/);
});

check("request context and environment", async () => {
  const response = await fetch(suite.base + "/api/context");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    clientAddress: "127.0.0.1",
    message: "SvelteKitとRustへようこそ。",
  });
});

check("native axum route coexists with SvelteKit", async () => {
  const response = await fetch(suite.base + "/api/rust");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { message: "served by axum" });
});

check("input budget and the following request", async () => {
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    body: "x".repeat(4097),
  });
  assert.equal(response.status, 413);
  assert.equal((await fetch(suite.base)).status, 200);
});

check("concurrent requests keep their own values", async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      const html = await (await fetch(suite.base + "/?name=" + name)).text();
      assert.match(html, new RegExp("こんにちは、" + name));
    }),
  );
});

check("browser hydration, form submission and client navigation", async () => {
  const page = await suite.page();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(suite.base);
  await page.waitForFunction(() => document.querySelector("main")?.dataset.hydrated === "true");
  await page.getByRole("button", { name: "クリック 0", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "クリック 1", exact: true }).count(), 1);

  await page.getByLabel("名前").fill("ブラウザ");
  await page.getByRole("button", { name: "挨拶する" }).click();
  await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("ブラウザ"));
  await page.waitForFunction(() => document.querySelector("main")?.dataset.hydrated === "true");

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
