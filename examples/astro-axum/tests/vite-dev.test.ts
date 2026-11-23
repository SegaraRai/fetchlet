// The `dev:vite` loop: `astro dev` with fetchlet/astro's `devServer`, and the
// server built with the `vite-dev` feature running Astro's development app
// from it on the engine. Edits are made in place and restored afterwards.

import { websocketCheck } from "@fetchlet-internal/tools-examples/common-checks";
import { viteDevSuite } from "@fetchlet-internal/tools-examples/vite-dev-suite";
import { expect } from "vite-plus/test";

// Astro's client router cancels a request when it navigates; the server
// lets it finish in the instance rather than load every module again.
const suite = viteDevSuite("astro-axum");

suite.check(
  "the engine renders Astro from Vite, with the Rust service binding",
  ["ssr", "bindings", "assets"],
  async () => {
    const response = await fetch(suite.base + "/?name=Vite");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<h1[^>]*>Hello, Vite<\/h1>/);
    expect(html).toContain("Welcome to Astro and Rust.");
    expect(html).toContain("Greetings from the Rust service.");
    // Development styles and the HMR client come from Vite.
    expect(html).toContain('<script type="module" src="/@vite/client"></script>');
    expect(html).toContain("data-vite-dev-id=");
  },
);

suite.check("endpoints answer from the engine", ["json", "client-address"], async () => {
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
  expect(context).toStrictEqual({
    clientAddress: "127.0.0.1",
    message: "Welcome to Astro and Rust.",
  });
});

suite.check("the island hydrates and the page navigates", ["hydration", "navigation"], async () => {
  const page = await suite.page();
  await page.goto(suite.base + "/", { waitUntil: "domcontentloaded" });
  await page.locator('[data-counter][data-hydrated="true"]').waitFor();
  await page.getByRole("button", { name: "Clicks 0", exact: true }).click();
  await page.getByRole("button", { name: "Clicks 1", exact: true }).waitFor();
  await page.getByRole("link", { name: "About" }).click();
  await page.waitForURL("**/about");
  await page.getByRole("heading", { name: "About" }).waitFor();
  await page.close();
});

suite.check(
  "a page edit renders on the next request and reloads the open page",
  ["ssr", "hydration"],
  async () => {
    const page = await suite.page();
    await page.goto(suite.base + "/about", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "About" }).waitFor();
    await suite.edit("web/pages/about.astro", "<h1>About</h1>", "<h1>About, edited</h1>");
    await suite.until(
      async () => (await (await fetch(suite.base + "/about")).text()).includes("About, edited"),
      "server render of the edit",
    );
    // Astro reloads pages whose server modules changed.
    await expect
      .poll(() => page.getByRole("heading").first().textContent(), { timeout: suite.deadline })
      .toBe("About, edited");
    await page.close();
  },
);

// Upgrades reach the app rather than the Vite dev server.
websocketCheck(suite, "Astro");
