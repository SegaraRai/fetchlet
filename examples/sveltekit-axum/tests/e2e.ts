import assert from "node:assert/strict";

import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("sveltekit-axum");
const { check } = suite;

check("SSR, escaping and the Rust service binding", async () => {
  const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & Svelte>"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /&lt;Rust &amp; Svelte>/);
  assert.match(html, /SvelteKitとRustへようこそ/);
  assert.match(html, /Rustサービスからの挨拶です/);
});

check("client JavaScript, CSS and static files", async () => {
  const html = await (await fetch(suite.base)).text();
  const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css))["']/g)]
    .map((match) => new URL(match[1]!, suite.base))
    .filter((url) => url.pathname.startsWith("/_app/"));
  assert.ok(assets.some((url) => url.pathname.endsWith(".js")));
  assert.ok(assets.some((url) => url.pathname.endsWith(".css")));
  for (const asset of assets) {
    const response = await fetch(asset);
    assert.equal(response.status, 200, asset.href);
    assert.match(
      response.headers.get("content-type") ?? "",
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
  assert.match(response.headers.get("set-cookie") ?? "", /visitor=/);
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

const stats = async () => (await fetch(suite.base + "/api/v1/stats")).json();
const inProcess = async (name: string) =>
  (await fetch(suite.base + "/api/in-process/" + name)).json();

check("in-process Rust API through event.fetch and the service binding", async () => {
  const empty = await fetch(suite.base + "/projects", {
    method: "POST",
    headers: { origin: suite.base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: " " }),
  });
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /name is required/);

  const created = await fetch(suite.base + "/projects", {
    method: "POST",
    headers: { origin: suite.base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "検証" }),
  });
  assert.equal(created.status, 200);
  assert.match(await (await fetch(suite.base + "/projects")).text(), /\d+: 検証/);

  const found = await fetch(suite.base + "/api/projects/1");
  assert.equal(found.status, 200);
  assert.equal((await found.json()).id, 1);
  // Browsers reach the same Rust router and state over public HTTP.
  const listed = await (await fetch(suite.base + "/api/v1/projects")).json();
  assert.ok(listed.some((project: { name: string }) => project.name === "検証"));

  const missing = await fetch(suite.base + "/api/projects/999");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "project not found" });
});

check("a Rust 500 reaches JavaScript as a Response", async () => {
  assert.deepEqual(await inProcess("failure"), { status: 500, body: { error: "internal error" } });
});

check("the trusted caller comes from Rust, not from headers", async () => {
  assert.deepEqual(await inProcess("caller"), { status: 200, body: { address: "127.0.0.1" } });
  const response = await fetch(suite.base + "/api/v1/caller", {
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  assert.equal(response.status, 401);
});

check("the fetch policy denies other origins on every path", async () => {
  const before = await stats();
  const outcome = await inProcess("denied");
  for (const path of ["binding", "global", "event"]) {
    assert.equal(outcome[path].rejected?.code, "PERMISSION_DENIED", path);
  }
  assert.equal((await stats()).calls, before.calls, "denied before reaching Rust");
});

check(
  "aborting an in-process fetch drops the Rust handler before the invocation ends",
  async () => {
    const before = await stats();
    const outcome = await inProcess("abort");
    assert.equal(outcome.rejected?.name, "AbortError");
    assert.equal(outcome.cancelledDuringInvocation, 1);
    assert.equal((await stats()).cancelled, before.cancelled + 1);
    assert.equal((await fetch(suite.base)).status, 200);
  },
);

check("same-origin event.fetch stays inside SvelteKit", async () => {
  const before = await stats();
  const outcome = await inProcess("internal");
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.message, "SvelteKitとRustへようこそ。");
  assert.equal((await stats()).calls, before.calls);
});

check("background work runs after the response and before the next request", async () => {
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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(suite.base);
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>("main")?.dataset.hydrated === "true",
  );
  await page.getByRole("button", { name: "クリック 0", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "クリック 1", exact: true }).count(), 1);

  await page.getByLabel("名前").fill("ブラウザ");
  await page.getByRole("button", { name: "挨拶する" }).click();
  await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("ブラウザ"));
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>("main")?.dataset.hydrated === "true",
  );

  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).fetchletNavigationMarker = "retained";
  });
  await page.getByRole("link", { name: "このページについて" }).click();
  await page.waitForURL("**/about");
  assert.equal(await page.getByRole("heading", { name: "このページについて" }).count(), 1);
  assert.equal(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).fetchletNavigationMarker,
    ),
    "retained",
  );
  assert.deepEqual(errors, []);
  await page.close();
});
