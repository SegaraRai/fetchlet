// The `dev:vite` loop: `vite dev` with fetchlet/react-router's dev server
// plugin, and the server built with the `vite-dev` feature running React
// Router's server build from it on the engine. Edits are made in place and
// restored afterwards.

import { websocketCheck } from "@fetchlet-internal/tools-examples/common-checks";
import { viteDevSuite } from "@fetchlet-internal/tools-examples/vite-dev-suite";
import { expect } from "vite-plus/test";

const suite = viteDevSuite("react-router-axum");

suite.check(
  "the engine renders React Router from Vite, with a loader calling Rust",
  ["ssr", "bindings", "assets"],
  async () => {
    const response = await fetch(suite.base + "/?name=Vite");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Hello, <!-- -->Vite</h1>");
    expect(html).toContain("Greetings from the Rust service.");
    // Development styles come from React Router's plugin in Vite.
    expect(html).toContain('href="/@react-router/critical.css?pathname=/"');
    const css = await fetch(suite.base + "/@react-router/critical.css?pathname=/");
    expect(css.headers.get("content-type")).toContain("text/css");
  },
);

suite.check("resource routes answer from the engine", ["json", "client-address"], async () => {
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
  "the page hydrates and navigates with loaders over HTTP",
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
    await suite.edit("app/components/Counter.tsx", "      Clicks {count}", "      Taps {count}");
    // React Fast Refresh keeps the count, so the page was not reloaded.
    await expect
      .poll(() => page.locator("[data-counter]").textContent(), { timeout: suite.deadline })
      .toBe("Taps 1");
    await suite.until(
      async () => (await (await fetch(suite.base + "/")).text()).includes("Taps <!-- -->0"),
      "server render of the edit",
    );
    await page.close();
  },
);

// Upgrades reach the app rather than the Vite dev server.
websocketCheck(suite, "React Router");
