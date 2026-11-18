import { assertStreams } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";
import { expect } from "vite-plus/test";

const suite = exampleSuite("astro-axum");
const { check } = suite;

check("Astro SSR, escaping and the Rust service binding", ["ssr", "bindings"], async () => {
  const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & Astro>"));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/&lt;Rust &amp; Astro(?:>|&gt;)/);
  expect(html).toMatch(/Welcome to Astro and Rust/);
  expect(html).toMatch(/Greetings from the Rust service/);
});

check("Astro streams the page while a component awaits", ["streaming-ssr"], async () => {
  await assertStreams(await fetch(suite.base + "/deferred"));
});

check("Astro JavaScript, CSS and static files", ["assets"], async () => {
  const html = await (await fetch(suite.base)).text();
  const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css))["']/g)]
    .map((match) => new URL(match[1]!, suite.base))
    .filter((url) => url.pathname.startsWith("/_astro/"));
  expect(assets.some((url) => url.pathname.endsWith(".js"))).toBeTruthy();
  expect(assets.some((url) => url.pathname.endsWith(".css"))).toBeTruthy();
  for (const asset of assets) {
    const response = await fetch(asset);
    expect(response.status, asset.href).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(
      asset.pathname.endsWith(".css") ? /css/ : /javascript/,
    );
  }
  expect(await (await fetch(suite.base + "/health.txt")).text()).toMatch(/astro-axum assets/);
  expect((await fetch(suite.base + "/server.js")).status).toBe(404);
});

check("Astro JSON endpoint", ["json"], async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toStrictEqual(value);
});

check("Astro form and Set-Cookie", ["form", "cookies"], async () => {
  const response = await fetch(suite.base, {
    method: "POST",
    headers: {
      origin: suite.base,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: "Zoë" }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie") ?? "").toMatch(/visitor=/);
  expect(await response.text()).toMatch(/Hello, Zoë/);
});

check("Astro client address and environment", ["client-address", "bindings"], async () => {
  const response = await fetch(suite.base + "/api/context");
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    clientAddress: "127.0.0.1",
    message: "Welcome to Astro and Rust.",
  });
});

check("native axum route coexists with Astro", ["rust-routes"], async () => {
  const response = await fetch(suite.base + "/api/rust");
  expect(await response.json()).toStrictEqual({ message: "served by axum" });
});

check("input budget and the following Astro request", ["body-budget"], async () => {
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
  "streamed uploads reach the endpoint in chunks within the budget",
  ["streaming-upload", "body-budget"],
  async () => {
    const response = await upload(3, 1000);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.bytes).toBe(3000);
    expect(result.chunks >= 2, `chunks: ${result.chunks}`).toBeTruthy();

    // Undeclared excess errors the endpoint's body stream.
    const oversized = await upload(5, 1000);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toStrictEqual({ error: "LIMIT_EXCEEDED" });
    expect((await fetch(suite.base)).status).toBe(200);
  },
);

check(
  "background work runs after the response and before the next request",
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
    const { completed } = await (await fetch(suite.base + "/api/background")).json();
    expect(completed.includes(label)).toBeTruthy();
  },
);

check("concurrent Astro requests keep their own values", ["concurrency"], async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      const html = await (await fetch(suite.base + "/?name=" + name)).text();
      expect(html).toMatch(new RegExp("Hello, " + name));
    }),
  );
});

check(
  "island hydration, form submission and Astro navigation",
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
