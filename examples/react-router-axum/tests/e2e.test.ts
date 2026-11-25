import {
  assertStreams,
  completedOnItsInstance,
  websocketCheck,
} from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";
import { expect } from "vite-plus/test";

const suite = exampleSuite("react-router-axum");
const { check } = suite;

// A browser user agent: crawlers receive the complete document at once.
const browser = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36" };

check("React Router SSR, escaping and the Rust service binding", ["ssr", "bindings"], async () => {
  const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & RR>"), {
    headers: browser,
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/Hello, (?:<!-- -->)?&lt;Rust &amp; RR&gt;/);
  expect(html).toMatch(/Welcome to React Router and Rust/);
  expect(html).toMatch(/Greetings from the Rust service/);
  // Every hoisted link is complete; a renderer retry must not leave a partial tag.
  expect(html).not.toMatch(/<link<|<link\/?>/);
  const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"\/>/g)];
  expect(preloads.length >= 3, `modulepreload links: ${preloads.length}`).toBeTruthy();
});

check("React Router JavaScript, CSS and public files", ["assets"], async () => {
  const html = await (await fetch(suite.base, { headers: browser })).text();
  const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css))["']/g)]
    .map((match) => new URL(match[1]!, suite.base))
    .filter((url) => url.pathname.startsWith("/assets/"));
  expect(assets.some((url) => url.pathname.endsWith(".js"))).toBeTruthy();
  expect(assets.some((url) => url.pathname.endsWith(".css"))).toBeTruthy();
  for (const asset of assets) {
    const response = await fetch(asset);
    expect(response.status, asset.href).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(
      asset.pathname.endsWith(".css") ? /css/ : /javascript/,
    );
  }
  expect(await (await fetch(suite.base + "/health.txt")).text()).toMatch(
    /react-router-axum assets/,
  );
  expect((await fetch(suite.base + "/server.js")).status).toBe(404);
  expect((await fetch(suite.base + "/server/index.js")).status).toBe(404);
});

check(
  "prerendered page from the asset archive, then hydration",
  ["assets", "hydration"],
  async () => {
    // react-router.config.ts prerenders /about; the archive answers it with an
    // ETag, which server-rendered pages do not carry, with or without a slash.
    for (const path of ["/about", "/about/"]) {
      const response = await fetch(suite.base + path, { headers: browser, redirect: "manual" });
      expect(response.status, path).toBe(200);
      expect(response.headers.get("etag"), path).toBeTruthy();
      expect(await response.text()).toMatch(/<h1>About<\/h1>/);
    }
    const page = await suite.page();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(suite.base + "/about");
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).fetchletNavigationMarker = "retained";
    });
    // The prerendered document hydrates and navigates on the client.
    await page.getByRole("link", { name: "Home" }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("[data-counter]")?.dataset.hydrated === "true",
    );
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).fetchletNavigationMarker,
      ),
    ).toBe("retained");
    expect(errors).toStrictEqual([]);
    await page.close();
  },
);

check("deferred loader data streams after the shell", ["streaming-ssr"], async () => {
  await assertStreams(await fetch(suite.base + "/deferred", { headers: browser }));
});

check("resource route JSON action", ["json"], async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toStrictEqual(value);
});

check("document form action and Set-Cookie", ["form", "cookies"], async () => {
  const response = await fetch(suite.base + "/?index", {
    method: "POST",
    headers: {
      ...browser,
      origin: suite.base,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: "Zoë" }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie") ?? "").toMatch(/visitor=/);
  expect(await response.text()).toMatch(/Hello, (?:<!-- -->)?Zoë/);
});

check(
  "client address and host bindings in the load context",
  ["client-address", "bindings"],
  async () => {
    const response = await fetch(suite.base + "/api/context");
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      clientAddress: "127.0.0.1",
      message: "Welcome to React Router and Rust.",
    });
  },
);

check("native axum route coexists with React Router", ["rust-routes"], async () => {
  const response = await fetch(suite.base + "/api/rust");
  expect(await response.json()).toStrictEqual({ message: "served by axum" });
});

check("input budget and the following React Router request", ["body-budget"], async () => {
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
  "streamed uploads reach the resource route in chunks within the budget",
  ["streaming-upload", "body-budget"],
  async () => {
    const response = await upload(3, 1000);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.bytes).toBe(3000);
    expect(result.chunks >= 2, `chunks: ${result.chunks}`).toBeTruthy();

    // Undeclared excess errors the action's body stream.
    const oversized = await upload(5, 1000);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toStrictEqual({ error: "LIMIT_EXCEEDED" });
    expect((await fetch(suite.base)).status).toBe(200);
  },
);

check(
  "context.waitUntil work runs after the response and before the next request",
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

check("concurrent React Router requests keep their own values", ["concurrency"], async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      const html = await (await fetch(suite.base + "/?name=" + name, { headers: browser })).text();
      expect(html).toMatch(new RegExp("Hello, (?:<!-- -->)?" + name));
    }),
  );
});

check(
  "hydration, client actions and React Router navigation",
  ["server-functions", "hydration", "navigation"],
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

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).fetchletNavigationMarker = "retained";
    });
    // The hydrated Form submits with fetch and keeps the document.
    await page.getByLabel("Name").fill("Browser");
    await page.getByRole("button", { name: "Greet" }).click();
    await page.waitForFunction(() =>
      document.querySelector("h1")?.textContent?.includes("Browser"),
    );
    expect(await page.getByRole("button", { name: "Clicks 1", exact: true }).count()).toBe(1);

    await page.getByRole("link", { name: "Deferred data" }).click();
    await page.waitForURL("**/deferred");
    await page.waitForFunction(() => document.querySelector("[data-resolved]") !== null);

    await page.getByRole("link", { name: "About" }).click();
    await page.waitForURL("**/about");
    // The URL changes before the route renders.
    await page.getByRole("heading", { name: "About" }).waitFor();
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

websocketCheck(suite, "React Router");
