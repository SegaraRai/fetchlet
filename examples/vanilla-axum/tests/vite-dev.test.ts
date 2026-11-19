// The `dev:vite` loop: `vite dev` with fetchlet/vite, and the server built
// with the `vite-dev` feature running the server module from it on the
// engine. Edits to the server module and the stylesheet are made in place
// and restored afterwards.

import { viteDevSuite } from "@fetchlet-internal/tools-examples/vite-dev-suite";
import { expect } from "vite-plus/test";

const suite = viteDevSuite("vanilla-axum");

suite.check("the engine renders the server module from Vite", ["ssr", "bindings"], async () => {
  const response = await fetch(suite.base + "/");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("<title>Hello, guest</title>");
  expect(html).toContain("From vanilla JavaScript");
  expect(html).toContain('src="/@fetchlet/client?entry=src%2Fclient.ts"');
});

suite.check("Rust calls a named export loaded from Vite", ["functions"], async () => {
  const response = await fetch(suite.base + "/api/greet?name=Vite");
  expect(await response.json()).toStrictEqual({ greeting: "Hello from JavaScript, Vite" });
});

suite.check("the browser entry hydrates from Vite's modules", ["hydration", "assets"], async () => {
  const page = await suite.page();
  await page.goto(suite.base + "/");
  await page.locator('[data-counter][data-hydrated="true"]').waitFor();
  await page.locator("[data-counter]").click();
  await expect.poll(() => page.locator("[data-counter]").textContent()).toBe("Clicks 1");
  expect(await page.evaluate(() => getComputedStyle(document.body).marginTop)).toBe("32px");
  await page.close();
});

suite.check("a server module edit serves the next request and reloads pages", ["ssr"], async () => {
  const page = await suite.page();
  await page.goto(suite.base + "/");
  await page.locator('[data-counter][data-hydrated="true"]').waitFor();
  await suite.edit("src/server.ts", "`Hello, ${name}`", "`Edited, ${name}`");
  await suite.until(
    async () =>
      (await (await fetch(suite.base + "/")).text()).includes("<title>Edited, guest</title>"),
    "server edit",
  );
  await expect.poll(() => page.title()).toBe("Edited, guest");
  await page.close();
});

suite.check("a stylesheet edit applies in place", ["assets"], async () => {
  const page = await suite.page();
  await page.goto(suite.base + "/");
  await page.locator('[data-counter][data-hydrated="true"]').waitFor();
  await page.locator("[data-counter]").click();
  await suite.edit("src/styles.css", "margin: 2rem;", "margin: 3rem;");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).marginTop))
    .toBe("48px");
  // The page kept its state, so it was not reloaded.
  expect(await page.locator("[data-counter]").textContent()).toBe("Clicks 1");
  await page.close();
});
