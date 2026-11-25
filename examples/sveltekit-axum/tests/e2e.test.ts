import {
  assertStreams,
  completedOnItsInstance,
  websocketCheck,
} from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";
import { expect } from "vite-plus/test";

const suite = exampleSuite("sveltekit-axum");
const { check } = suite;

check("SSR, escaping and the Rust service binding", ["ssr", "bindings"], async () => {
  const response = await fetch(suite.base + "/?name=" + encodeURIComponent("<Rust & Svelte>"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type") ?? "").toMatch(/text\/html/);
  const html = await response.text();
  expect(html).toMatch(/&lt;Rust &amp; Svelte>/);
  expect(html).toMatch(/Welcome to SvelteKit and Rust/);
  expect(html).toMatch(/Greetings from the Rust service/);
});

check("a promise from load streams after the page", ["streaming-ssr"], async () => {
  await assertStreams(await fetch(suite.base + "/deferred"));
});

check("client JavaScript, CSS and static files", ["assets"], async () => {
  const html = await (await fetch(suite.base)).text();
  const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css))["']/g)]
    .map((match) => new URL(match[1]!, suite.base))
    .filter((url) => url.pathname.startsWith("/_app/"));
  expect(assets.some((url) => url.pathname.endsWith(".js"))).toBeTruthy();
  expect(assets.some((url) => url.pathname.endsWith(".css"))).toBeTruthy();
  for (const asset of assets) {
    const response = await fetch(asset);
    expect(response.status, asset.href).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(
      asset.pathname.endsWith(".css") ? /css/ : /javascript/,
    );
    expect((await response.text()).length > 0).toBeTruthy();
  }
  expect(await (await fetch(suite.base + "/health.txt")).text()).toMatch(/sveltekit-axum assets/);
  expect((await fetch(suite.base + "/server.js")).status).toBe(404);
});

check("SvelteKit JSON endpoint", ["json"], async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toStrictEqual(value);
});

check("form action and Set-Cookie", ["form", "cookies"], async () => {
  const response = await fetch(suite.base, {
    method: "POST",
    headers: {
      origin: suite.base,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: "Zoë" }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie") ?? "").toMatch(/visitor=/);
  expect(await response.text()).toMatch(/Zoë/);
});

check("request context and environment", ["client-address", "bindings"], async () => {
  const response = await fetch(suite.base + "/api/context");
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    clientAddress: "127.0.0.1",
    message: "Welcome to SvelteKit and Rust.",
  });
});

check("native axum route coexists with SvelteKit", ["rust-routes"], async () => {
  const response = await fetch(suite.base + "/api/rust");
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({ message: "served by axum" });
});

check("input budget and the following request", ["body-budget"], async () => {
  const response = await fetch(suite.base + "/api/echo", {
    method: "POST",
    body: "x".repeat(4097),
  });
  expect(response.status).toBe(413);
  expect((await fetch(suite.base)).status).toBe(200);
});

const stats = async () => (await fetch(suite.base + "/api/v1/stats")).json();
const inProcess = async (name: string) =>
  (await fetch(suite.base + "/api/in-process/" + name)).json();

check(
  "in-process Rust API through event.fetch and the service binding",
  ["internal-fetch"],
  async () => {
    const empty = await fetch(suite.base + "/projects", {
      method: "POST",
      headers: { origin: suite.base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: " " }),
    });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toMatch(/name is required/);

    const created = await fetch(suite.base + "/projects", {
      method: "POST",
      headers: { origin: suite.base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Review" }),
    });
    expect(created.status).toBe(200);
    expect(await (await fetch(suite.base + "/projects")).text()).toMatch(/\d+: Review/);

    const found = await fetch(suite.base + "/api/projects/1");
    expect(found.status).toBe(200);
    expect((await found.json()).id).toBe(1);
    // Browsers reach the same Rust router and state over public HTTP.
    const listed = await (await fetch(suite.base + "/api/v1/projects")).json();
    expect(listed.some((project: { name: string }) => project.name === "Review")).toBeTruthy();

    const missing = await fetch(suite.base + "/api/projects/999");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toStrictEqual({ error: "project not found" });
  },
);

check("a Rust 500 reaches JavaScript as a Response", ["internal-fetch"], async () => {
  expect(await inProcess("failure")).toStrictEqual({
    status: 500,
    body: { error: "internal error" },
  });
});

check("the trusted caller comes from Rust, not from headers", ["internal-fetch"], async () => {
  expect(await inProcess("caller")).toStrictEqual({ status: 200, body: { address: "127.0.0.1" } });
  const response = await fetch(suite.base + "/api/v1/caller", {
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  expect(response.status).toBe(401);
});

check("the fetch policy denies other origins on every path", ["internal-fetch"], async () => {
  const before = await stats();
  const outcome = await inProcess("denied");
  for (const path of ["binding", "global", "event"]) {
    expect(outcome[path].rejected?.code, path).toBe("PERMISSION_DENIED");
  }
  expect((await stats()).calls, "denied before reaching Rust").toBe(before.calls);
});

check(
  "aborting an in-process fetch drops the Rust handler before the invocation ends",
  ["internal-fetch"],
  async () => {
    const before = await stats();
    const outcome = await inProcess("abort");
    expect(outcome.rejected?.name).toBe("AbortError");
    expect(outcome.cancelledDuringInvocation).toBe(1);
    expect((await stats()).cancelled).toBe(before.cancelled + 1);
    expect((await fetch(suite.base)).status).toBe(200);
  },
);

check("same-origin event.fetch stays inside SvelteKit", ["framework-fetch"], async () => {
  const before = await stats();
  const outcome = await inProcess("internal");
  expect(outcome.status).toBe(200);
  expect(outcome.body.message).toBe("Welcome to SvelteKit and Rust.");
  expect((await stats()).calls).toBe(before.calls);
});

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
    expect(await completedOnItsInstance(suite.base, label)).toBeTruthy();
  },
);

check("concurrent requests keep their own values", ["concurrency"], async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      const html = await (await fetch(suite.base + "/?name=" + name)).text();
      expect(html).toMatch(new RegExp("Hello, " + name));
    }),
  );
});

check(
  "browser hydration, form submission and client navigation",
  ["form", "hydration", "navigation"],
  async () => {
    const page = await suite.page();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(suite.base);
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("main")?.dataset.hydrated === "true",
    );
    await page.getByRole("button", { name: "Clicks 0", exact: true }).click();
    expect(await page.getByRole("button", { name: "Clicks 1", exact: true }).count()).toBe(1);

    await page.getByLabel("Name").fill("Browser");
    await page.getByRole("button", { name: "Greet" }).click();
    await page.waitForFunction(() =>
      document.querySelector("h1")?.textContent?.includes("Browser"),
    );
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>("main")?.dataset.hydrated === "true",
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

websocketCheck(suite, "SvelteKit");
