// The `dev:vite` loop: `vite dev` with fetchlet/solid, and the server built
// with the `vite-dev` feature running Solid's request handler from it on the
// engine. Edits are made in place and restored afterwards.

import { websocketCheck } from "@fetchlet-internal/tools-examples/common-checks";
import { viteDevSuite } from "@fetchlet-internal/tools-examples/vite-dev-suite";
import { expect } from "vite-plus/test";

const suite = viteDevSuite("solid-axum");

suite.check(
  "the engine renders Solid from Vite, with a server function calling Rust",
  ["ssr", "server-functions", "bindings", "assets"],
  async () => {
    const response = await fetch(suite.base + "/?name=Vite");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Hello, Vite</h1>");
    expect(html).toContain("From Solid");
    expect(html).toContain("Greetings from the Rust service.");
    // Vite's client and the development styles of the rendered modules.
    expect(html).toContain("/@vite/client");
    expect(html).toContain("data-vite-dev-id=");
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
  expect(await echo.json()).toStrictEqual({
    value: 1,
  });
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
    await page.locator('nav a[href="/about"]').click();
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
    await page.evaluate(() => Object.assign(window, { beforeEdit: true }));
    await suite.edit("src/components/Counter.tsx", "{`Clicks ${count()}`}", "{`Taps ${count()}`}");
    // Solid's hot module replacement remounts the component in the open page.
    await expect
      .poll(() => page.locator("[data-counter]").textContent(), { timeout: suite.deadline })
      .toBe("Taps 0");
    expect(await page.evaluate(() => "beforeEdit" in window)).toBe(true);
    await suite.until(
      async () => (await (await fetch(suite.base + "/")).text()).includes("Taps 0"),
      "server render of the edit",
    );
    await page.close();
  },
);

// Upgrades reach the app rather than the Vite dev server.
websocketCheck(suite, "Solid");
