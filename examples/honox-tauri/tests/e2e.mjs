// Drives the Tauri app through WebView2's DevTools protocol. Every request
// below is made by the webview itself, so it reaches the `fetchlet` URI scheme
// protocol in the app process; no HTTP server is involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const name = "honox-tauri";
const root = resolve(import.meta.dirname, "../../..");
const example = resolve(root, "examples", name);
const output = resolve(root, ".cache", name);
const origin = "http://fetchlet.localhost";
const message = "HonoXとTauriへようこそ。";
// WebView2 exposes the DevTools protocol; WebKitGTK and WKWebView do not.
const supported = process.platform === "win32";
const results = [];
let child;
let browser;
let page;
let stderr = "";

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(operation, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      if (error?.fatal) throw error;
    }
    if (Date.now() > deadline) throw new Error(label + " deadline: " + stderr);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

before(async () => {
  if (!supported) return;
  await mkdir(output, { recursive: true });
  const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
  config.build_directory = resolve(example, "build");
  config.request_body_bytes = 4096;
  // Match the backend of an artifact built with FETCHLET_BACKEND.
  if (process.env.FETCHLET_BACKEND) config.backend = process.env.FETCHLET_BACKEND;
  const configPath = resolve(output, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const port = await freePort();
  child = spawn(resolve(root, "target/debug/example-" + name + ".exe"), [configPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
    },
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  let ready = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("FETCHLET_TAURI_READY ")) ready = true;
  });
  await waitFor(() => {
    if (exited) throw Object.assign(new Error("App exited: " + stderr), { fatal: true });
    return ready;
  }, "App startup");
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
    "DevTools endpoint",
  );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await waitFor(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith(origin)),
    "Main window",
  );
  page.setDefaultTimeout(10000);
  await page.waitForLoadState();
});

after(async () => {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  if (!supported) return;
  await mkdir(resolve(root, "results"), { recursive: true });
  await writeFile(resolve(output, "app.log"), stderr);
  await writeFile(
    resolve(root, "results/example-" + name + ".json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        summary: {
          passed: results.filter((result) => result.status === "pass").length,
          failed: results.filter((result) => result.status === "fail").length,
        },
        browser: browser?.version(),
        results,
      },
      null,
      2,
    ) + "\n",
  );
});

function check(label, operation) {
  test(label, { timeout: 30000, skip: !supported && "needs WebView2 (Windows)" }, async () => {
    try {
      await operation();
      results.push({ name: label, status: "pass" });
    } catch (error) {
      results.push({ name: label, status: "fail", error: String(error.stack ?? error) });
      throw error;
    }
  });
}

/** Fetch from inside the webview and return the status, content type and text. */
function request(path, init = {}) {
  return page.evaluate(
    async ([path, init]) => {
      const response = await fetch(path, init);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        text: await response.text(),
      };
    },
    [path, init],
  );
}

function post(path, value) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

check("the main window opens on the fetchlet scheme", async () => {
  assert.equal(new URL(page.url()).origin, origin);
});

check("HonoX SSR, escaping and the Rust service binding", async () => {
  const response = await request("/?name=" + encodeURIComponent("<Rust & JS>"));
  assert.equal(response.status, 200);
  assert.match(response.text, /こんにちは、&lt;Rust &amp; JS&gt;/);
  assert.ok(response.text.includes(message), "MESSAGE binding");
  assert.match(response.text, /Rustサービスからの挨拶です/);
});

check("JavaScript, CSS and public files from the client build", async () => {
  const { text } = await request("/");
  const assets = [...text.matchAll(/["'](\/static\/[^"'<>\s]+\.(?:js|css))["']/g)].map(
    (match) => match[1],
  );
  assert.ok(
    assets.some((path) => path.endsWith(".js")),
    "JavaScript assets",
  );
  assert.ok(
    assets.some((path) => path.endsWith(".css")),
    "CSS assets",
  );
  for (const path of assets) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.type, path.endsWith(".css") ? /css/ : /javascript/);
  }
  assert.match((await request("/health.txt")).text, /honox-tauri assets/);
  // server.js lives next to client/, outside the served directory.
  assert.equal((await request("/server.js")).status, 404);
  assert.equal((await request("/%2e%2e/server.js")).status, 404);
  assert.equal((await request("/static/..%2f..%2fserver.js")).status, 404);
});

check("JSON endpoint", async () => {
  const value = { message: "日本語😀", values: [0, 128, 255] };
  const response = await post("/api/echo", value);
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(response.text), value);
});

check("in-process requests carry no client address", async () => {
  const response = await request("/api/context");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { message });
});

check("a Rust route of the protocol coexists with HonoX", async () => {
  const response = await request("/api/rust");
  assert.deepEqual(JSON.parse(response.text), { message: "served by the Tauri protocol" });
});

check("request body budget and the following request", async () => {
  const response = await post("/api/echo", "x".repeat(4097));
  assert.equal(response.status, 413);
  assert.equal((await request("/")).status, 200);
});

check("background work runs after the response and before the next request", async () => {
  const label = "job-" + Date.now();
  const response = await post("/api/background", { label });
  assert.equal(response.status, 202);
  const accepted = JSON.parse(response.text);
  assert.equal(accepted.accepted, label);
  assert.ok(!accepted.completed.includes(label), "sent before the work finished");
  const { completed } = JSON.parse((await request("/api/background")).text);
  assert.ok(completed.includes(label));
});

check("concurrent requests keep their own values", async () => {
  await Promise.all(
    ["Alice", "Bob", "Carol", "Dave"].map(async (name) => {
      assert.match((await request("/?name=" + name)).text, new RegExp("こんにちは、" + name));
    }),
  );
});

check("hydration, a Tauri command calling a JavaScript export, and navigation", async () => {
  const errors = [];
  const record = (error) => errors.push(String(error));
  page.on("pageerror", record);
  try {
    await page.goto(origin + "/");
    await page.waitForFunction(
      () => document.querySelector("[data-counter]")?.getAttribute("data-hydrated") === "true",
    );
    await page.getByRole("button", { name: "クリック 0", exact: true }).click();
    await page.getByRole("button", { name: "クリック 1", exact: true }).waitFor();

    await page.locator("[data-greeter] input").fill("フェッチレット");
    await page.getByRole("button", { name: "commandで挨拶" }).click();
    await page
      .locator("[data-greeting]")
      .filter({ hasText: "フェッチレットさん、JavaScriptの関数からこんにちは。（7文字）" })
      .waitFor();

    await page.getByRole("link", { name: "このページについて" }).click();
    await page.waitForURL(/\/about\/?$/);
    await page.getByRole("heading", { name: "このページについて" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    page.off("pageerror", record);
  }
});
