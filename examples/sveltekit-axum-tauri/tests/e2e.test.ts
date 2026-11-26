// `mdw serve` over real HTTP and a real browser: SSR, hydration, remote
// functions, the typed Rust API, live updates, the workspace boundary and the
// client assets embedded in the binary.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { brotliDecompressSync } from "node:zlib";

import type { Feature } from "@fetchlet-internal/tools-examples/features";
import { backend, resultFile } from "@fetchlet-internal/tools-examples/suite";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import { environment, summarize, writeResult } from "@fetchlet-internal/tools-workspace/results";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const name = "sveltekit-axum-tauri";
const example = resolve(root, "examples", name);
const output = resolve(root, ".cache", name, "e2e");
const notes = resolve(output, "notes");
const results: { name: string; features: Feature[]; status: "pass" | "fail"; error?: string }[] =
  [];
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let base: string;
let stderr = "";

beforeAll(async () => {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(resolve(example, "sample"), notes, { recursive: true });
  // A file outside the workspace that no request may read.
  await writeFile(resolve(output, "secret.md"), "# Secret\n");
  const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
  config.backend = backend;
  const configPath = resolve(output, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const executable = resolve(
    root,
    "target/debug/mdw" + (process.platform === "win32" ? ".exe" : ""),
  );
  const app = spawn(
    executable,
    ["--config", configPath, "serve", notes, "--listen", "127.0.0.1:0"],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child = app;
  app.stderr.on("data", (data) => (stderr += data));
  const lines = createInterface({ input: app.stdout });
  base = await new Promise<string>((resolveAddress, reject) => {
    const failed = (error: Error) => {
      clearTimeout(deadline);
      reject(error);
    };
    const deadline = setTimeout(() => failed(new Error("startup deadline: " + stderr)), 20000);
    app.once("error", failed);
    app.once("exit", (code) => failed(new Error("mdw exited " + code + ": " + stderr)));
    lines.on("line", (line) => {
      if (line.startsWith("MDW_LISTENING ")) {
        clearTimeout(deadline);
        resolveAddress(line.slice("MDW_LISTENING ".length));
      }
    });
  });
});

afterAll(async () => {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await writeFile(resolve(output, "server.log"), stderr);
  writeResult(resultFile(name), {
    backend,
    environment: environment({ packagesOf: example }),
    browser: browser?.version(),
    summary: summarize(results),
    results,
  });
});

function check(label: string, features: Feature[], operation: () => Promise<void>): void {
  test(label, { timeout: 30000 }, async () => {
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

async function page(options: BrowserContextOptions = {}): Promise<Page & { errors: string[] }> {
  browser ??= await chromium.launch({
    headless: true,
    channel: process.env.FETCHLET_BROWSER_CHANNEL || undefined,
  });
  const context = await browser.newContext(options);
  const page = (await context.newPage()) as Page & { errors: string[] };
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.errors = errors;
  return page;
}

// Responses are checked by value, so their bodies stay untyped.
async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(base + path, init);
  return { status: response.status, body: await response.json() };
}

/** A raw request with a chosen Host header, which fetch does not allow. */
function withHost(host: string, path: string): Promise<number | undefined> {
  const url = new URL(path, base);
  return new Promise<number | undefined>((resolveStatus, reject) => {
    const outgoing = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { host },
      },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** A raw GET with chosen headers, keeping the body as sent. */
function raw(
  path: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  const url = new URL(path, base);
  return new Promise((resolveResponse, reject) => {
    const outgoing = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

check("client assets come from the archive embedded in mdw", ["assets"], async () => {
  const home = await fetch(base + "/").then((response) => response.text());
  const script = /\/_app\/immutable\/[^"]+\.js/.exec(home)?.[0];
  if (!script) {
    expect.fail("the page links a hashed script");
  }
  const compressed = await raw(script, {
    "accept-encoding": "gzip, deflate, br",
  });
  expect(compressed.status).toBe(200);
  expect(compressed.headers["content-encoding"]).toBe("br");
  expect(compressed.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(compressed.headers.vary).toBe("accept-encoding");
  // Clients without Brotli, such as plain HTTP outside localhost, get it decompressed.
  const plain = await raw(script, { "accept-encoding": "gzip, deflate" });
  expect(plain.headers["content-encoding"]).toBe(undefined);
  expect(brotliDecompressSync(compressed.body)).toStrictEqual(plain.body);
  const cached = await raw(script, {
    "if-none-match": String(plain.headers.etag),
  });
  expect(cached.status).toBe(304);
});

check(
  "SSR renders the workspace, the note tree and Markdown through the JavaScript renderer",
  ["ssr"],
  async () => {
    const home = await fetch(base + "/").then((response) => response.text());
    expect(home).toMatch(/<a class="brand" href="\/">notes<\/a>/);
    expect(home).toMatch(/4 notes/);
    expect(home).toMatch(/href="\/notes\/guide\/getting-started\.md"/);

    const response = await fetch(base + "/notes/index.md");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<title>Welcome — mdw<\/title>/);
    // Relative links and images are rewritten to workspace routes.
    expect(html).toMatch(/href="\/notes\/guide\/architecture\.md#rendering"/);
    expect(html).toMatch(/src="\/files\/images\/flow\.svg"/);
    expect(html).toMatch(/<li>#fetchlet<\/li>/);
  },
);

check(
  "code blocks are highlighted by syntect in Rust during SSR",
  ["ssr", "internal-fetch"],
  async () => {
    const html = await fetch(base + "/notes/guide/architecture.md").then((r) => r.text());
    expect(html).toMatch(
      /<code class="language-rust highlighted"><span class="hl-source hl-rust">/,
    );
    expect(html).toMatch(/<code class="language-ts highlighted">/);
    expect(html).toMatch(/<h2 id="rendering">Rendering<\/h2>/);
    const css = await fetch(base + "/api/v1/highlight.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toMatch(/prefers-color-scheme: dark/);
  },
);

check("raw HTML in a note is dropped from the rendered page", [], async () => {
  const html = await fetch(base + "/notes/journal/2026-11-17.md").then((r) => r.text());
  expect(html).not.toMatch(/<script>alert/);
  expect(html).toMatch(/Raw HTML is removed when rendering./);
});

check(
  "the public API serves the same typed handlers as the in-process API",
  ["json", "internal-fetch"],
  async () => {
    const listed = await json("/api/v1/notes");
    expect(listed.status).toBe(200);
    expect(listed.body.map((note: { path: string }) => note.path)).toStrictEqual([
      "guide/architecture.md",
      "guide/getting-started.md",
      "index.md",
      "journal/2026-11-17.md",
    ]);
    const search = await json("/api/v1/search?q=" + encodeURIComponent("日本語"));
    expect(search.body[0].path).toBe("journal/2026-11-17.md");
    expect(
      search.body[0].snippet
        .filter((part: { matched: boolean }) => part.matched)
        .map((part: { text: string }) => part.text),
    ).toStrictEqual(["日本語"]);
    const note = await json("/api/v1/note?path=index.md");
    expect(note.body.title).toBe("Welcome");
    expect(note.body.version).toMatch(/^[0-9a-f]{64}$/);
  },
);

check(
  "a save based on a stale version is a conflict that names the current version",
  [],
  async () => {
    const { body: note } = await json("/api/v1/note?path=guide/getting-started.md");
    const put = (content: string, base_version: string | null) =>
      json("/api/v1/note", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: note.path, content, base_version }),
      });
    const saved = await put(note.content + "\nAppended\n", note.version);
    expect(saved.status).toBe(200);
    const stale = await put("lost", note.version);
    expect(stale.status).toBe(409);
    expect(stale.body.conflict.current_version).toBe(saved.body.version);
    const created = await put("# exists", null);
    expect(created.status).toBe(409);
  },
);

check("paths outside the workspace are refused by the API and the file route", [], async () => {
  for (const path of [
    "../secret.md",
    "/etc/passwd",
    "a/../../secret.md",
    ".git/config",
    "C:/secret.md",
  ]) {
    const response = await json("/api/v1/note?path=" + encodeURIComponent(path));
    expect(response.status, path).toBe(400);
  }
  for (const path of [
    "/files/..%2fsecret.md",
    "/files/%2e%2e/secret.md",
    "/files/guide/..%2f..%2fsecret.md",
  ]) {
    const response = await fetch(base + path);
    expect(response.status, path).not.toBe(200);
    expect(await response.text(), path).not.toMatch(/Secret/);
  }
  const put = await fetch(base + "/api/v1/note", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "../escape.md",
      content: "x",
      base_version: null,
    }),
  });
  expect(put.status).toBe(400);
});

check("workspace files are served sandboxed", [], async () => {
  const response = await fetch(base + "/files/images/flow.svg");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy") ?? "").toMatch(/^sandbox/);
});

check("requests for another host name are refused", [], async () => {
  expect(await withHost(new URL(base).host, "/")).toBe(200);
  expect(await withHost("rebound.example:80", "/")).toBe(421);
  expect(await withHost("localhost:1", "/api/v1/notes")).toBe(421);
});

check(
  "the page hydrates, searches with remote functions and navigates on the client",
  ["server-functions", "hydration", "navigation"],
  async () => {
    const browserPage = await page();
    await browserPage.goto(base + "/");
    // LocalTime switches from the SSR date to the browser's local format.
    await browserPage.waitForFunction(() =>
      [...document.querySelectorAll("time")].some((time) => time.textContent.length > 10),
    );
    await browserPage.getByRole("searchbox").fill("syntect");
    const suggestion = browserPage.locator(".suggestions a").first();
    await suggestion.waitFor();
    expect((await suggestion.textContent()) ?? "").toMatch(/How it works/);
    expect(await browserPage.locator(".suggestions mark").first().textContent()).toBe("syntect");

    await browserPage.getByRole("searchbox").press("Escape");
    await browserPage.locator(".suggestions").waitFor({ state: "detached" });
    await browserPage.evaluate(
      () => ((window as unknown as Record<string, unknown>).__marker = true),
    );
    await browserPage.locator(".tree").getByRole("link", { name: "Getting started" }).click();
    await browserPage.waitForURL(/getting-started\.md$/);
    await browserPage.locator("h1", { hasText: "Getting started" }).waitFor();
    // Client navigation keeps the same document.
    expect(
      await browserPage.evaluate(() => (window as unknown as Record<string, unknown>).__marker),
    ).toBe(true);
    expect(browserPage.errors).toStrictEqual([]);
  },
);

check(
  "the editor previews through the Rust process and saves with Ctrl+S",
  ["server-functions"],
  async () => {
    const browserPage = await page();
    await browserPage.goto(base + "/notes/guide/architecture.md/edit");
    const editor = browserPage.getByRole("textbox", { name: "Markdown" });
    await editor.waitFor();
    await editor.click();
    await browserPage.keyboard.press("Control+Home");
    await browserPage.keyboard.type("## Preview heading\n\n```rust\nfn preview() {}\n```\n\n");
    const preview = browserPage.locator(".preview");
    await preview.locator("h2", { hasText: "Preview heading" }).waitFor();
    await preview.locator("code.language-rust.highlighted").first().waitFor();
    expect(await browserPage.locator(".status").textContent()).toBe("Unsaved changes");

    await browserPage.keyboard.press("Control+s");
    await browserPage.waitForURL(/\/notes\/guide\/architecture\.md$/);
    await browserPage.locator(".markdown h2", { hasText: "Preview heading" }).waitFor();
    const saved = await readFile(resolve(notes, "guide/architecture.md"), "utf8");
    expect(saved.startsWith("## Preview heading\n"), saved.slice(0, 80)).toBeTruthy();
    expect(browserPage.errors).toStrictEqual([]);
  },
);

check("a change saved outside the browser reaches the open page", [], async () => {
  const browserPage = await page();
  await browserPage.goto(base + "/notes/index.md");
  await browserPage.locator("h1", { hasText: "Welcome" }).waitFor();
  await writeFile(
    resolve(notes, "index.md"),
    "# Updated elsewhere\n\nSaved from another editor.\n",
  );
  await browserPage.locator("h1", { hasText: "Updated elsewhere" }).waitFor({ timeout: 10000 });
  // The tree shows the new title too.
  await browserPage.locator(".tree a", { hasText: "Updated elsewhere" }).waitFor();
});

check("the editor reports a conflict and can overwrite the version on disk", [], async () => {
  const browserPage = await page();
  await browserPage.goto(base + "/notes/journal/2026-11-17.md/edit");
  const editor = browserPage.getByRole("textbox", { name: "Markdown" });
  await editor.click();
  await browserPage.keyboard.press("Control+End");
  await browserPage.keyboard.type("\nAppended in the browser\n");
  await writeFile(resolve(notes, "journal/2026-11-17.md"), "# Another change\n");
  await browserPage.locator(".banner", { hasText: "changed outside the editor" }).waitFor();
  await browserPage.keyboard.press("Control+s");
  await browserPage.getByRole("alert").waitFor();
  expect((await browserPage.getByRole("alert").textContent()) ?? "").toMatch(
    /changed after it was loaded/,
  );
  await browserPage.getByRole("button", { name: "Overwrite with this version" }).click();
  await browserPage.waitForURL(/\/notes\/journal\/2026-11-17\.md$/);
  const saved = await readFile(resolve(notes, "journal/2026-11-17.md"), "utf8");
  expect(saved).toMatch(/Appended in the browser/);
  expect(saved).not.toMatch(/Another change/);
});

check(
  "new notes are created through a validated remote form",
  ["form", "server-functions"],
  async () => {
    const browserPage = await page();
    await browserPage.goto(base + "/new");
    // Hydration sets the field from the form's state, which would clear a
    // name typed before it, so the form is filled once the scripts have run.
    await browserPage.waitForLoadState("networkidle");
    const input = browserPage.getByRole("textbox", { name: /Name/ });
    await input.fill("guide/getting-started");
    await browserPage.getByRole("button", { name: "Create and edit" }).click();
    await browserPage
      .locator(".error", { hasText: "A note with this name already exists" })
      .waitFor();

    await input.fill("projects/café-plan");
    await browserPage.getByRole("button", { name: "Create and edit" }).click();
    await browserPage.waitForURL(/projects\/caf%C3%A9-plan\.md\/edit$/);
    const created = await readFile(resolve(notes, "projects/café-plan.md"), "utf8");
    expect(created).toBe("# café-plan\n\n");
    await browserPage.locator(".tree a", { hasText: "café-plan" }).waitFor();
  },
);

check("search and notes work without JavaScript", ["ssr", "form"], async () => {
  const browserPage = await page({ javaScriptEnabled: false });
  await browserPage.goto(base + "/");
  await browserPage.getByRole("searchbox").fill("workspace");
  await browserPage.getByRole("searchbox").press("Enter");
  await browserPage.waitForURL(/\/search\?q=/);
  await browserPage.locator(".results a").first().click();
  await browserPage.waitForURL(/\/notes\//);
  expect(((await browserPage.locator(".markdown").textContent()) ?? "").length > 0).toBeTruthy();
});
