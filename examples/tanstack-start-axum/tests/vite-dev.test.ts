// The `dev:vite` loop: `vite dev` with fetchlet/tanstack-start, and the
// server built with the `vite-dev` feature running Start's server entry from
// it on the engine. Edits are made in place and restored afterwards.

import { viteDevSuite } from "@fetchlet-internal/tools-examples/vite-dev-suite";
import { expect } from "vite-plus/test";

const suite = viteDevSuite("tanstack-start-axum", {
  unsupported: {
    // Debug builds of Boa take minutes to evaluate Start's development
    // modules one by one; built artifacts run on Boa in the main suite.
    boa: "Start's development modules take minutes to evaluate on Boa",
  },
});

suite.check(
  "the engine renders Start from Vite, with a server function calling Rust",
  ["ssr", "server-functions", "bindings"],
  async () => {
    const response = await fetch(suite.base + "/?name=Vite");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Hello, <!-- -->Vite</h1>");
    expect(html).toContain("Greetings from the Rust service.");
    expect(html).toContain("/@id/virtual:tanstack-start-dev-client-entry");
  },
);

suite.check("server routes answer from the engine", ["json", "client-address"], async () => {
  const echo = await fetch(suite.base + "/api/echo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      value: 1,
    }),
  });
  expect(echo.status).toBe(201);
  expect(await echo.json()).toStrictEqual({ value: 1 });
  const context = await (await fetch(suite.base + "/api/context")).json();
  expect(context.clientAddress).toBe("127.0.0.1");
});

suite.check(
  "the page hydrates and navigates with server functions over HTTP",
  ["hydration", "navigation"],
  async () => {
    const page = await suite.page();
    await page.goto(suite.base + "/", { waitUntil: "domcontentloaded" });
    await page.locator('[data-counter][data-hydrated="true"]').waitFor();
    await page.locator('a[href="/about"]').click();
    await page.locator("h1", { hasText: "About" }).waitFor();
    await page.locator('nav a[href="/"]').click();
    await page.locator("[data-service]", { hasText: "Greetings from the Rust service." }).waitFor();
    await page.close();
  },
);

suite.check(
  "a component edit refreshes in place and renders on the next request",
  ["hydration", "ssr"],
  async () => {
    const page = await suite.page();
    await page.goto(suite.base + "/", { waitUntil: "domcontentloaded" });
    await page.locator('[data-counter][data-hydrated="true"]').waitFor();
    await page.locator("[data-counter]").click();
    await suite.edit("src/components/Counter.tsx", "      Clicks {count}", "      Taps {count}");
    // React Fast Refresh keeps the count, so the page was not reloaded.
    await expect.poll(() => page.locator("[data-counter]").textContent()).toBe("Taps 1");
    await suite.until(
      async () => (await (await fetch(suite.base + "/")).text()).includes("Taps <!-- -->0"),
      "server render of the edit",
    );
    await page.close();
  },
);
