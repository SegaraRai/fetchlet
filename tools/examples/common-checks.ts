// Checks shared by framework examples that implement the common app shape:
//
// - `/` renders `こんにちは、{name}` from `?name=`, the MESSAGE binding and
//   the greeting of the RUST service binding;
// - `/about` is reachable through a client-side link named このページについて;
// - a button `[data-counter]` sets `data-hydrated="true"` after hydration and
//   counts clicks as `クリック {n}`;
// - `/api/echo` returns a posted JSON body with 201;
// - `/api/context` returns `{ clientAddress, message }`;
// - `/api/upload` counts a streamed upload as `{ chunks, bytes }`, or answers
//   413 `{ error: "LIMIT_EXCEEDED" }` when the stream errors with that code;
// - `/api/background` POST `{ label }` registers waitUntil work and answers
//   202 `{ accepted, completed }`; GET returns `{ completed }`;
// - POST requests carry the Origin header a browser sends, which CSRF checks
//   such as Qwik City's require;
// - the Rust server serves `/api/rust` and `/health.txt`.
import assert from "node:assert/strict";

import type { ExampleSuite } from "./suite.ts";

export interface CommonCheckOptions {
  framework: string;
  example: string;
  message: string;
  assetPrefix: string;
  requireCss?: boolean;
  hiddenPaths?: string[];
  clientNavigation?: boolean;
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

  check(`${framework} SSR, escaping and the Rust service binding`, async () => {
    const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & JS>"), {
      headers: browserHeaders,
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    // HTML text needs `<` and `&` escaped; Solid leaves `>` as it is.
    assert.match(html, new RegExp("こんにちは、" + rendered("&lt;Rust &amp; JS(?:&gt;|>)")));
    assert.ok(html.includes(options.message), "MESSAGE binding");
    assert.match(html, /Rustサービスからの挨拶です/);
  });

  check(
    `${framework} JavaScript${options.requireCss === false ? "" : ", CSS"} and public files`,
    async () => {
      const html = await (await fetch(suite.base, { headers: browserHeaders })).text();
      const assets = [...html.matchAll(/["']([^"'<>\s]+\.(?:js|mjs|css))["']/g)]
        .map((match) => new URL(match[1]!, suite.base))
        .filter((url) => url.origin === new URL(suite.base).origin)
        .filter((url) => url.pathname.startsWith(options.assetPrefix));
      assert.ok(
        assets.some((url) => /\.m?js$/.test(url.pathname)),
        "JavaScript assets",
      );
      if (options.requireCss !== false) {
        assert.ok(
          assets.some((url) => url.pathname.endsWith(".css")),
          "CSS assets",
        );
      }
      for (const asset of assets) {
        const response = await fetch(asset);
        assert.equal(response.status, 200, asset.href);
        assert.match(
          response.headers.get("content-type") ?? "",
          asset.pathname.endsWith(".css") ? /css/ : /javascript/,
        );
        // Served from the artifact's asset archive with the framework's caching.
        assert.ok(response.headers.get("etag"), `${asset.pathname} ETag`);
        assert.match(response.headers.get("cache-control") ?? "", /immutable/, asset.pathname);
      }
      assert.match(
        await (await fetch(suite.base + "/health.txt")).text(),
        new RegExp(options.example + " assets"),
      );
      for (const path of ["/server.js", ...(options.hiddenPaths ?? [])]) {
        assert.equal((await fetch(suite.base + path)).status, 404, path);
      }
    },
  );

  check(`${framework} JSON endpoint`, async () => {
    const value = { message: "日本語😀", values: [0, 128, 255] };
    const response = await fetch(suite.base + "/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", origin: suite.base },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), value);
  });

  check(`${framework} client address and host bindings`, async () => {
    const response = await fetch(suite.base + "/api/context");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      clientAddress: "127.0.0.1",
      message: options.message,
    });
  });

  check(`native axum route coexists with ${framework}`, async () => {
    const response = await fetch(suite.base + "/api/rust");
    assert.deepEqual(await response.json(), { message: "served by axum" });
  });

  check(`input budget and the following ${framework} request`, async () => {
    const response = await fetch(suite.base + "/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", origin: suite.base },
      body: JSON.stringify("x".repeat(4097)),
    });
    assert.equal(response.status, 413);
    assert.equal((await fetch(suite.base, { headers: browserHeaders })).status, 200);
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

  check(`streamed uploads reach ${framework} in chunks within the budget`, async () => {
    const response = await upload(3, 1000);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.bytes, 3000);
    assert.ok(result.chunks >= 2, `chunks: ${result.chunks}`);

    // Undeclared excess errors the handler's body stream.
    const oversized = await upload(5, 1000);
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "LIMIT_EXCEEDED" });
    assert.equal((await fetch(suite.base, { headers: browserHeaders })).status, 200);
  });

  check(
    `${framework} background work runs after the response and before the next request`,
    async () => {
      const label = "job-" + Date.now();
      const response = await fetch(suite.base + "/api/background", {
        method: "POST",
        headers: { "content-type": "application/json", origin: suite.base },
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

  check(`concurrent ${framework} requests keep their own values`, async () => {
    await Promise.all(
      ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
        const html = await (
          await fetch(suite.base + "/?name=" + name, { headers: browserHeaders })
        ).text();
        assert.match(html, new RegExp("こんにちは、" + rendered(name)));
      }),
    );
  });

  const navigation = options.clientNavigation === false ? "navigation" : "client navigation";
  check(`${framework} hydration and ${navigation}`, async () => {
    const page = await suite.page();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(suite.base);
    await page.waitForFunction(
      () => document.querySelector("[data-counter]")?.getAttribute("data-hydrated") === "true",
    );
    await page.getByRole("button", { name: "クリック 0", exact: true }).click();
    await page.getByRole("button", { name: "クリック 1", exact: true }).waitFor();

    await page.evaluate(() => {
      window.fetchletNavigationMarker = "retained";
    });
    await page.getByRole("link", { name: "このページについて" }).click();
    await page.waitForURL(/\/about\/?$/);
    await page.getByRole("heading", { name: "このページについて" }).waitFor();
    // A client-side router keeps the document; a document navigation replaces it.
    assert.equal(
      await page.evaluate(() => window.fetchletNavigationMarker),
      options.clientNavigation === false ? undefined : "retained",
    );
    assert.deepEqual(errors, []);
    await page.close();
  });
}
