// Checks shared by framework examples that implement the common app shape:
//
// - `/` renders `Hello, {name}` from `?name=`, the MESSAGE binding and
//   the greeting of the RUST service binding;
// - `/about` is reachable through a client-side link named About;
// - a button `[data-counter]` sets `data-hydrated="true"` after hydration and
//   counts clicks as `Clicks {n}`;
// - `/api/echo` returns a posted JSON body with 201;
// - `/api/context` returns `{ clientAddress, message }`;
// - `/api/upload` counts a streamed upload as `{ chunks, bytes }`, or answers
//   413 `{ error: "LIMIT_EXCEEDED" }` when the stream errors with that code;
// - `/api/background` POST `{ label }` registers waitUntil work and answers
//   202 `{ accepted, completed }`; GET returns `{ completed }`;
// - POST requests carry the Origin header a browser sends, which CSRF checks
//   such as Qwik City's require;
// - the Rust server serves `/api/rust` and `/health.txt`;
// - with `streaming`, `/deferred` sends `Loading…` first and
//   `A value that arrived late` about 200 ms later, in the same response.

import { expect } from "vite-plus/test";

import type { ExampleSuite } from "./suite.ts";

export interface CommonCheckOptions {
  framework: string;
  example: string;
  message: string;
  assetPrefix: string;
  requireCss?: boolean;
  hiddenPaths?: string[];
  clientNavigation?: boolean;
  /** Whether `/deferred` streams its slow part after the shell. */
  streaming?: boolean;
}

declare global {
  interface Window {
    fetchletNavigationMarker?: string;
  }
}

/** A browser user agent: crawlers may receive complete documents only. */
export const browserHeaders = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
};

/** Text as a framework renders it next to other text: React may add `<!-- -->`. */
const rendered = (text: string) => "(?:<!-- -->)?" + text;

export function commonChecks(suite: ExampleSuite, options: CommonCheckOptions): void {
  const { check } = suite;
  const { framework } = options;

  check(
    `${framework} SSR, escaping and the Rust service binding`,
    ["ssr", "bindings"],
    async () => {
      const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & JS>"), {
        headers: browserHeaders,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      // HTML text needs `<` and `&` escaped; Solid leaves `>` as it is.
      expect(html).toMatch(new RegExp("Hello, " + rendered("&lt;Rust &amp; JS(?:&gt;|>)")));
      expect(html.includes(options.message), "MESSAGE binding").toBeTruthy();
      expect(html).toMatch(/Greetings from the Rust service/);
    },
  );

  check(
    `${framework} JavaScript${options.requireCss === false ? "" : ", CSS"} and public files`,
    ["assets"],
    async () => {
      const html = await (await fetch(suite.base, { headers: browserHeaders })).text();
      const assets = [...html.matchAll(/["']([^"'<>\s]+\.(?:js|mjs|css))["']/g)]
        .map((match) => new URL(match[1]!, suite.base))
        .filter((url) => url.origin === new URL(suite.base).origin)
        .filter((url) => url.pathname.startsWith(options.assetPrefix));
      expect(
        assets.some((url) => /\.m?js$/.test(url.pathname)),
        "JavaScript assets",
      ).toBeTruthy();
      if (options.requireCss !== false) {
        expect(
          assets.some((url) => url.pathname.endsWith(".css")),
          "CSS assets",
        ).toBeTruthy();
      }
      for (const asset of assets) {
        const response = await fetch(asset);
        expect(response.status, asset.href).toBe(200);
        expect(response.headers.get("content-type") ?? "").toMatch(
          asset.pathname.endsWith(".css") ? /css/ : /javascript/,
        );
        // Served from the artifact's asset archive with the framework's caching.
        expect(response.headers.get("etag"), `${asset.pathname} ETag`).toBeTruthy();
        expect(response.headers.get("cache-control") ?? "", asset.pathname).toMatch(/immutable/);
      }
      expect(await (await fetch(suite.base + "/health.txt")).text()).toMatch(
        new RegExp(options.example + " assets"),
      );
      for (const path of ["/server.js", ...(options.hiddenPaths ?? [])]) {
        expect((await fetch(suite.base + path)).status, path).toBe(404);
      }
    },
  );

  check(`${framework} JSON endpoint`, ["json"], async () => {
    const value = { message: "日本語😀", values: [0, 128, 255] };
    const response = await fetch(suite.base + "/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", origin: suite.base },
      body: JSON.stringify(value),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toStrictEqual(value);
  });

  check(
    `${framework} client address and host bindings`,
    ["client-address", "bindings"],
    async () => {
      const response = await fetch(suite.base + "/api/context");
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({
        clientAddress: "127.0.0.1",
        message: options.message,
      });
    },
  );

  check(`native axum route coexists with ${framework}`, ["rust-routes"], async () => {
    const response = await fetch(suite.base + "/api/rust");
    expect(await response.json()).toStrictEqual({ message: "served by axum" });
  });

  check(`input budget and the following ${framework} request`, ["body-budget"], async () => {
    const response = await fetch(suite.base + "/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", origin: suite.base },
      body: JSON.stringify("x".repeat(4097)),
    });
    expect(response.status).toBe(413);
    expect((await fetch(suite.base, { headers: browserHeaders })).status).toBe(200);
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
      headers: { "content-type": "application/octet-stream", origin: suite.base },
      body,
      duplex: "half",
    } as RequestInit);
  }

  check(
    `streamed uploads reach ${framework} in chunks within the budget`,
    ["streaming-upload", "body-budget"],
    async () => {
      const response = await upload(3, 1000);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.bytes).toBe(3000);
      expect(result.chunks >= 2, `chunks: ${result.chunks}`).toBeTruthy();

      // Undeclared excess errors the handler's body stream.
      const oversized = await upload(5, 1000);
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toStrictEqual({ error: "LIMIT_EXCEEDED" });
      expect((await fetch(suite.base, { headers: browserHeaders })).status).toBe(200);
    },
  );

  check(
    `${framework} background work runs after the response and before the next request`,
    ["wait-until"],
    async () => {
      const label = "job-" + Date.now();
      const response = await fetch(suite.base + "/api/background", {
        method: "POST",
        headers: { "content-type": "application/json", origin: suite.base },
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

  check(`concurrent ${framework} requests keep their own values`, ["concurrency"], async () => {
    await Promise.all(
      ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
        const html = await (
          await fetch(suite.base + "/?name=" + name, { headers: browserHeaders })
        ).text();
        expect(html).toMatch(new RegExp("Hello, " + rendered(name)));
      }),
    );
  });

  const navigation = options.clientNavigation === false ? "navigation" : "client navigation";
  check(`${framework} hydration and ${navigation}`, ["hydration", "navigation"], async () => {
    const page = await suite.page();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(suite.base);
    await page.waitForFunction(
      () => document.querySelector("[data-counter]")?.getAttribute("data-hydrated") === "true",
    );
    await page.getByRole("button", { name: "Clicks 0", exact: true }).click();
    await page.getByRole("button", { name: "Clicks 1", exact: true }).waitFor();

    await page.evaluate(() => {
      window.fetchletNavigationMarker = "retained";
    });
    await page.getByRole("link", { name: "About" }).click();
    await page.waitForURL(/\/about\/?$/);
    await page.getByRole("heading", { name: "About" }).waitFor();
    // A client-side router keeps the document; a document navigation replaces it.
    expect(await page.evaluate(() => window.fetchletNavigationMarker)).toBe(
      options.clientNavigation === false ? undefined : "retained",
    );
    expect(errors).toStrictEqual([]);
    await page.close();
  });

  if (options.streaming) {
    check(`${framework} streams deferred content after the shell`, ["streaming-ssr"], async () => {
      await assertStreams(await fetch(suite.base + "/deferred", { headers: browserHeaders }));
    });
  }
}

/**
 * Asserts that a response sends its `Loading…` shell before the slow value:
 * the shell must arrive while the value is still pending on the server.
 */
export async function assertStreams(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  if (!response.body) {
    expect.fail("the response has a body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("Loading")) {
    const { done, value } = await reader.read();
    expect(!done, "the response ended before the shell: " + received.slice(-200)).toBeTruthy();
    received += decoder.decode(value, { stream: true });
  }
  expect(received, "the slow value arrived with the shell").not.toMatch(
    /A value that arrived late/,
  );
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += decoder.decode(value, { stream: true });
  }
  expect(received).toMatch(/A value that arrived late/);
}
