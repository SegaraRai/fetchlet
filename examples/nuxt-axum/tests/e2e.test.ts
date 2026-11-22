import {
  completedOnItsInstance,
  websocketCheck,
} from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";
import { expect } from "vite-plus/test";

const suite = exampleSuite("nuxt-axum");
const { check } = suite;

check(
  "Nuxt SSR, escaping, runtime config and the Rust service binding",
  ["ssr", "bindings"],
  async () => {
    const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & Nuxt>"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/Hello, &lt;Rust &amp; Nuxt&gt;/);
    // useFetch reaches the server route through a nested Nitro fetch.
    expect(html).toMatch(/Welcome to Nuxt and Rust/);
    expect(html).toMatch(/Greetings from the Rust service/);
  },
);

check("Nuxt JavaScript, CSS and public files", ["assets"], async () => {
  const html = await (await fetch(suite.base)).text();
  const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css))["']/g)]
    .map((match) => new URL(match[1]!, suite.base))
    .filter((url) => url.pathname.startsWith("/_nuxt/"));
  expect(assets.some((url) => url.pathname.endsWith(".js"))).toBeTruthy();
  expect(assets.some((url) => url.pathname.endsWith(".css"))).toBeTruthy();
  for (const asset of assets) {
    const response = await fetch(asset);
    expect(response.status, asset.href).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(
      asset.pathname.endsWith(".css") ? /css/ : /javascript/,
    );
  }
  expect(await (await fetch(suite.base + "/health.txt")).text()).toMatch(/nuxt-axum assets/);
  expect((await fetch(suite.base + "/server.js")).status).toBe(404);
});

check("Nitro JSON route", ["json"], async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toStrictEqual(value);
});

check("form post, Set-Cookie and redirect", ["form", "cookies"], async () => {
  const response = await fetch(suite.base + "/greet", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Zoë" }),
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/?name=" + encodeURIComponent("Zoë"));
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/visitor=/);
  const page = await fetch(suite.base, {
    headers: { cookie: cookie.split(";")[0]! },
  });
  expect(await page.text()).toMatch(/Hello, Zoë/);
});

check("Nitro client address and host bindings", ["client-address", "bindings"], async () => {
  const response = await fetch(suite.base + "/api/context");
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    clientAddress: "127.0.0.1",
    message: "Welcome to Nuxt and Rust.",
  });
});

check("native axum route coexists with Nuxt", ["rust-routes"], async () => {
  const response = await fetch(suite.base + "/api/rust");
  expect(await response.json()).toStrictEqual({ message: "served by axum" });
});

check("input budget and the following Nuxt request", ["body-budget"], async () => {
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    body: "x".repeat(4097),
  });
  expect(response.status).toBe(413);
  expect((await fetch(suite.base)).status).toBe(200);
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
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.bytes).toBe(3000);
    expect(result.chunks >= 2, `chunks: ${result.chunks}`).toBeTruthy();

    // Undeclared excess errors the route's body stream.
    const oversized = await upload(5, 1000);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toStrictEqual({ error: "LIMIT_EXCEEDED" });
    expect((await fetch(suite.base)).status).toBe(200);
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
    expect(response.status).toBe(202);
    const accepted = await response.json();
    expect(accepted.accepted).toBe(label);
    expect(!accepted.completed.includes(label), "sent before the work finished").toBeTruthy();
    expect(await completedOnItsInstance(suite.base, label)).toBeTruthy();
  },
);

check("concurrent Nuxt requests keep their own values", ["concurrency"], async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      const html = await (await fetch(suite.base + "/?name=" + name)).text();
      expect(html).toMatch(new RegExp("Hello, " + name));
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
    expect(await page.getByRole("button", { name: "Clicks 1", exact: true }).count()).toBe(1);

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
    expect(await page.getByRole("heading", { name: "About" }).count()).toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).fetchletNavigationMarker,
      ),
    ).toBe("retained");
    expect(errors).toStrictEqual([]);
    await page.close();
  },
);

websocketCheck(suite, "Nuxt");
