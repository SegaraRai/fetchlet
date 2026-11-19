// `mdw desktop` driven through WebView2's DevTools protocol. Every request
// below comes from the webview and reaches the `mdw` URI scheme protocol in
// the app process, which answers with the same router `mdw serve` uses.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type { Feature } from "@fetchlet-internal/tools-examples/features";
import { backend, resultFile } from "@fetchlet-internal/tools-examples/suite";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import { environment, summarize, writeResult } from "@fetchlet-internal/tools-workspace/results";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const name = "sveltekit-axum-tauri";
const example = resolve(root, "examples", name);
const output = resolve(root, ".cache", name, "desktop");
const notes = resolve(output, "notes");
const origin = "http://mdw.localhost";
// WebView2 exposes the DevTools protocol; WebKitGTK and WKWebView do not.
const supported = process.platform === "win32";
const results: { name: string; features: Feature[]; status: "pass" | "fail"; error?: string }[] =
  [];
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;
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
  timeout = 30000,
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
      throw new Error(label + " deadline: " + stderr);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

beforeAll(async () => {
  if (!supported) {
    return;
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(resolve(example, "sample"), notes, { recursive: true });
  await writeFile(resolve(output, "secret.md"), "# Secret\n");
  const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
  config.backend = backend;
  const configPath = resolve(output, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const port = await freePort();
  const app = spawn(
    resolve(root, "target/debug/mdw.exe"),
    ["--config", configPath, "desktop", notes],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FETCHLET_DEVTOOLS_PORT: String(port),
      },
    },
  );
  child = app;
  app.stderr.on("data", (data) => (stderr += data));
  let exited = false;
  app.once("exit", () => (exited = true));
  let ready = false;
  createInterface({ input: app.stdout }).on("line", (line) => {
    if (line.startsWith("MDW_DESKTOP_READY ")) {
      ready = true;
    }
  });
  await waitFor(() => {
    if (exited) {
      throw Object.assign(new Error("mdw exited: " + stderr), { fatal: true });
    }
    return ready;
  }, "app startup");
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
    "DevTools endpoint",
  );
  const connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser = connected;
  page = await waitFor(
    () =>
      connected
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith(origin)),
    "main window",
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
  writeResult(resultFile(`${name}-desktop`), {
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

check("the window renders the workspace through the URI scheme protocol", ["ssr"], async () => {
  await page.goto(origin + "/");
  await page.locator(".brand", { hasText: "notes" }).waitFor();
  expect((await page.locator("main").textContent()) ?? "").toMatch(/4 notes/);
  // The page runs in the Tauri webview, not in a browser of `mdw serve`.
  expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(true);
});

check(
  "notes render with code highlighted by Rust, all in-process",
  ["ssr", "internal-fetch"],
  async () => {
    await page.goto(origin + "/notes/guide/architecture.md");
    await page.locator("code.language-rust.highlighted .hl-source").first().waitFor();
    const css = await page.evaluate(async () => {
      const response = await fetch("/api/v1/highlight.css");
      return [response.status, response.headers.get("content-type")];
    });
    expect(css).toStrictEqual([200, "text/css; charset=utf-8"]);
  },
);

check("the protocol keeps the workspace boundary", [], async () => {
  const statuses = await page.evaluate(async () => {
    const results: [number, boolean][] = [];
    for (const path of [
      "/api/v1/note?path=..%2Fsecret.md",
      "/files/..%2fsecret.md",
      "/files/%2e%2e/secret.md",
    ]) {
      const response = await fetch(path);
      results.push([response.status, (await response.text()).includes("Secret")]);
    }
    return results;
  });
  for (const [status, leaked] of statuses) {
    expect(status).not.toBe(200);
    expect(leaked).toBe(false);
  }
});

check("workspace changes arrive as Tauri events", [], async () => {
  await page.goto(origin + "/notes/index.md");
  await page.locator("h1", { hasText: "Welcome" }).waitFor();
  await writeFile(resolve(notes, "index.md"), "# Updated on the desktop\n");
  await page.locator("h1", { hasText: "Updated on the desktop" }).waitFor();
  // The desktop window does not open the server-sent event stream.
  const streams = await page.evaluate(() =>
    performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/events")),
  );
  expect(streams).toStrictEqual([]);
});

check("the editor saves through the protocol", ["server-functions"], async () => {
  await page.goto(origin + "/notes/guide/getting-started.md/edit");
  const editor = page.getByRole("textbox", { name: "Markdown" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\nSaved from the desktop\n");
  await page.locator(".preview", { hasText: "Saved from the desktop" }).waitFor();
  await page.keyboard.press("Control+s");
  await page.waitForURL(/getting-started\.md$/);
  await page.locator(".markdown", { hasText: "Saved from the desktop" }).waitFor();
  const saved = await readFile(resolve(notes, "guide/getting-started.md"), "utf8");
  expect(saved).toMatch(/Saved from the desktop/);
});
