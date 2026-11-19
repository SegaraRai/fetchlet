// Drives the Tauri app through WebView2's DevTools protocol. Every request
// below is made by the webview itself, so it reaches the `fetchlet` URI scheme
// protocol in the app process; no HTTP server is involved.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type { Feature } from "@fetchlet-internal/tools-examples/features";
import { backend, resultFile } from "@fetchlet-internal/tools-examples/suite";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import { environment, summarize, writeResult } from "@fetchlet-internal/tools-workspace/results";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const name = "honox-tauri";
const example = resolve(root, "examples", name);
const output = resolve(root, ".cache", name);
const origin = "http://fetchlet.localhost";
const message = "Welcome to HonoX and Tauri.";
// WebView2 exposes the DevTools protocol; WebKitGTK and WKWebView do not.
const supported = process.platform === "win32";
const results: {
  name: string;
  features: Feature[];
  status: "pass" | "fail";
  error?: string;
}[] = [];
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;
let stdout = "";
let stderr = "";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor<T>(
  operation: () => T | Promise<T>,
  label: string,
  timeout = 20000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await operation();
      if (value) {
        return value as NonNullable<T>;
      }
    } catch (error) {
      if ((error as { fatal?: boolean } | undefined)?.fatal) {
        throw error;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`${label} deadline\nstdout: ${stdout}\nstderr: ${stderr}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

beforeAll(async () => {
  if (!supported) {
    return;
  }
  await mkdir(output, { recursive: true });
  const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
  config.build_directory = resolve(example, "build");
  config.request_body_bytes = 4096;
  // Match the backend of an artifact built with FETCHLET_BACKEND.
  config.backend = backend;
  const configPath = resolve(output, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const port = await freePort();
  const app = spawn(resolve(root, "target/debug/example-" + name + ".exe"), [configPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
    },
  });
  child = app;
  app.stderr.on("data", (data) => {
    stderr += data;
  });
  let exited = false;
  app.once("exit", () => {
    exited = true;
  });
  let ready = false;
  createInterface({ input: app.stdout }).on("line", (line) => {
    stdout += line + "\n";
    if (line.startsWith("FETCHLET_TAURI_READY ")) {
      ready = true;
    }
  });
  await waitFor(() => {
    if (exited) {
      throw Object.assign(new Error("App exited: " + stderr), { fatal: true });
    }
    return ready;
  }, "App startup");
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
    "DevTools endpoint",
    // WebView2 creates its user data folder and starts its browser process on
    // first use, which takes longer than 20 seconds on a fresh CI runner.
    60000,
  );
  const connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser = connected;
  page = await waitFor(
    () =>
      connected
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith(origin)),
    "Main window",
  );
  page.setDefaultTimeout(10000);
  await page.waitForLoadState();
});

afterAll(async () => {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  if (!supported) {
    return;
  }
  await writeFile(resolve(output, "app.log"), stderr);
  writeResult(resultFile(name), {
    backend,
    environment: environment({ packagesOf: example }),
    browser: browser?.version(),
    summary: summarize(results),
    results,
  });
});

function check(label: string, features: Feature[], operation: () => Promise<void>): void {
  // Skipped where WebView2 (Windows) is unavailable.
  test.skipIf(!supported)(label, { timeout: 30000 }, async () => {
    try {
      await operation();
      results.push({ name: label, features, status: "pass" });
    } catch (error) {
      results.push({
        name: label,
        features,
        status: "fail",
        error: String((error as { stack?: string } | undefined)?.stack ?? error),
      });
      throw error;
    }
  });
}

/** A RequestInit that survives the DevTools protocol. */
interface WebviewInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Fetch from inside the webview and return the status, content type and text. */
function request(path: string, init: WebviewInit = {}) {
  return page.evaluate(
    async ([path, init]: [string, WebviewInit]) => {
      const response = await fetch(path, init);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        text: await response.text(),
      };
    },
    [path, init] as [string, WebviewInit],
  );
}

function post(path: string, value: unknown) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

check("the main window opens on the fetchlet scheme", [], async () => {
  expect(new URL(page.url()).origin).toBe(origin);
});

check("HonoX SSR, escaping and the Rust service binding", ["ssr", "bindings"], async () => {
  const response = await request("/?name=" + encodeURIComponent("<Rust & JS>"));
  expect(response.status).toBe(200);
  expect(response.text).toMatch(/Hello, &lt;Rust &amp; JS&gt;/);
  expect(response.text.includes(message), "MESSAGE binding").toBeTruthy();
  expect(response.text).toMatch(/Greetings from the Rust service/);
});

check("JavaScript, CSS and public files from the client build", ["assets"], async () => {
  const { text } = await request("/");
  const assets = [...text.matchAll(/["'](\/static\/[^"'<>\s]+\.(?:js|css))["']/g)].map(
    (match) => match[1]!,
  );
  expect(
    assets.some((path) => path.endsWith(".js")),
    "JavaScript assets",
  ).toBeTruthy();
  expect(
    assets.some((path) => path.endsWith(".css")),
    "CSS assets",
  ).toBeTruthy();
  for (const path of assets) {
    const response = await request(path);
    expect(response.status, path).toBe(200);
    expect(response.type ?? "").toMatch(path.endsWith(".css") ? /css/ : /javascript/);
  }
  expect((await request("/health.txt")).text).toMatch(/honox-tauri assets/);
  // server.js lives next to client/, outside the served directory.
  expect((await request("/server.js")).status).toBe(404);
  expect((await request("/%2e%2e/server.js")).status).toBe(404);
  expect((await request("/static/..%2f..%2fserver.js")).status).toBe(404);
});

check("JSON endpoint", ["json"], async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await post("/api/echo", value);
  expect(response.status).toBe(201);
  expect(JSON.parse(response.text)).toStrictEqual(value);
});

check("in-process requests carry no client address", ["bindings"], async () => {
  const response = await request("/api/context");
  expect(response.status).toBe(200);
  expect(JSON.parse(response.text)).toStrictEqual({ message });
});

check("a Rust route of the protocol coexists with HonoX", ["rust-routes"], async () => {
  const response = await request("/api/rust");
  expect(JSON.parse(response.text)).toStrictEqual({ message: "served by the Tauri protocol" });
});

check("request body budget and the following request", ["body-budget"], async () => {
  const response = await post("/api/echo", "x".repeat(4097));
  expect(response.status).toBe(413);
  expect((await request("/")).status).toBe(200);
});

check(
  "background work runs after the response and before the next request",
  ["wait-until"],
  async () => {
    const label = "job-" + Date.now();
    const response = await post("/api/background", { label });
    expect(response.status).toBe(202);
    const accepted = JSON.parse(response.text);
    expect(accepted.accepted).toBe(label);
    expect(!accepted.completed.includes(label), "sent before the work finished").toBeTruthy();
    const { completed } = JSON.parse((await request("/api/background")).text);
    expect(completed.includes(label)).toBeTruthy();
  },
);

check("concurrent requests keep their own values", ["concurrency"], async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      expect((await request("/?name=" + name)).text).toMatch(new RegExp("Hello, " + name));
    }),
  );
});

check(
  "hydration, a Tauri command calling a JavaScript export, and navigation",
  ["hydration", "navigation"],
  async () => {
    const errors: string[] = [];
    const record = (error: Error) => errors.push(String(error));
    page.on("pageerror", record);
    try {
      await page.goto(origin + "/");
      await page.waitForFunction(
        () => document.querySelector("[data-counter]")?.getAttribute("data-hydrated") === "true",
      );
      await page.getByRole("button", { name: "Clicks 0", exact: true }).click();
      await page.getByRole("button", { name: "Clicks 1", exact: true }).waitFor();

      await page.locator("[data-greeter] input").fill("Zoë😀");
      await page.getByRole("button", { name: "Greet with a command" }).click();
      await page
        .locator("[data-greeting]")
        .filter({ hasText: "Hello from a JavaScript function, Zoë😀. (4 characters)" })
        .waitFor();

      await page.getByRole("link", { name: "About" }).click();
      await page.waitForURL(/\/about\/?$/);
      await page.getByRole("heading", { name: "About" }).waitFor();
      expect(errors).toStrictEqual([]);
    } finally {
      page.off("pageerror", record);
    }
  },
);
