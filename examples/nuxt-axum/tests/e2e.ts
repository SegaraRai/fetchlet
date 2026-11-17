import assert from "node:assert/strict";

import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";

const suite = exampleSuite("nuxt-axum");
const { check } = suite;

check(
  "Nuxt SSR, escaping, runtime config and the Rust service binding",
  ["ssr", "bindings"],
  async () => {
    const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & Nuxt>"));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Hello, &lt;Rust &amp; Nuxt&gt;/);
    // useFetch reaches the server route through a nested Nitro fetch.
    assert.match(html, /Welcome to Nuxt and Rust/);
    assert.match(html, /Greetings from the Rust service/);
  },
);

check("Nuxt JavaScript, CSS and public files", ["assets"], async () => {
  const html = await (await fetch(suite.base)).text();
  const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css))["']/g)]
    .map((match) => new URL(match[1]!, suite.base))
    .filter((url) => url.pathname.startsWith("/_nuxt/"));
  assert.ok(assets.some((url) => url.pathname.endsWith(".js")));
  assert.ok(assets.some((url) => url.pathname.endsWith(".css")));
  for (const asset of assets) {
    const response = await fetch(asset);
    assert.equal(response.status, 200, asset.href);
    assert.match(
      response.headers.get("content-type") ?? "",
      asset.pathname.endsWith(".css") ? /css/ : /javascript/,
    );
  }
  assert.match(await (await fetch(suite.base + "/health.txt")).text(), /nuxt-axum assets/);
  assert.equal((await fetch(suite.base + "/server.js")).status, 404);
});

check("Nitro JSON route", ["json"], async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), value);
});

check("form post, Set-Cookie and redirect", ["form", "cookies"], async () => {
  const response = await fetch(suite.base + "/greet", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Zoë" }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/?name=" + encodeURIComponent("Zoë"));
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /visitor=/);
  const page = await fetch(suite.base, {
    headers: { cookie: cookie.split(";")[0]! },
  });
  assert.match(await page.text(), /Hello, Zoë/);
});

check("Nitro client address and host bindings", ["client-address", "bindings"], async () => {
  const response = await fetch(suite.base + "/api/context");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    clientAddress: "127.0.0.1",
    message: "Welcome to Nuxt and Rust.",
  });
});

check("native axum route coexists with Nuxt", ["rust-routes"], async () => {
  const response = await fetch(suite.base + "/api/rust");
  assert.deepEqual(await response.json(), { message: "served by axum" });
});

check("input budget and the following Nuxt request", ["body-budget"], async () => {
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    body: "x".repeat(4097),
  });
  assert.equal(response.status, 413);
  assert.equal((await fetch(suite.base)).status, 200);
});

// A chunked upload without Content-Length, produced over time.
function upload(chunks: number, size: number): Promise<Response> {
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
  } as RequestInit);
}

check(
  "streamed uploads reach the Nitro route in chunks within the budget",
  ["streaming-upload", "body-budget"],
  async () => {
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
  },
);

check(
  "event.waitUntil work runs after the response and before the next request",
  ["wait-until"],
  async () => {
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
  },
);

check("concurrent Nuxt requests keep their own values", ["concurrency"], async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      const html = await (await fetch(suite.base + "/?name=" + name)).text();
      assert.match(html, new RegExp("Hello, " + name));
    }),
  );
});

check(
  "hydration, form submission and Nuxt navigation",
  ["form", "hydration", "navigation"],
  async () => {
    const page = await suite.page();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(suite.base);
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("[data-counter]")?.dataset.hydrated === "true",
    );
    await page.getByRole("button", { name: "Clicks 0", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Clicks 1", exact: true }).count(), 1);

    await page.getByLabel("Name").fill("Browser");
    await page.getByRole("button", { name: "Greet" }).click();
    await page.waitForFunction(() =>
      document.querySelector("h1")?.textContent?.includes("Browser"),
    );
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("[data-counter]")?.dataset.hydrated === "true",
    );

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).fetchletNavigationMarker = "retained";
    });
    await page.getByRole("link", { name: "About" }).click();
    await page.waitForURL("**/about");
    assert.equal(await page.getByRole("heading", { name: "About" }).count(), 1);
    assert.equal(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).fetchletNavigationMarker,
      ),
      "retained",
    );
    assert.deepEqual(errors, []);
    await page.close();
  },
);
