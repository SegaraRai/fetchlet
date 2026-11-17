// `mdw serve` over real HTTP and a real browser: SSR, hydration, remote
// functions, the typed Rust API, live updates, the workspace boundary and the
// client assets embedded in the binary.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { brotliDecompressSync } from "node:zlib";
import { after, before, test } from "node:test";

import type { Feature } from "@fetchlet-internal/tools-examples/features";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import { environment, summarize, writeResult } from "@fetchlet-internal/tools-workspace/results";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";

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

before(async () => {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(resolve(example, "sample"), notes, { recursive: true });
  // A file outside the workspace that no request may read.
  await writeFile(resolve(output, "secret.md"), "# Secret\n");
  const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
  if (process.env.FETCHLET_BACKEND) config.backend = process.env.FETCHLET_BACKEND;
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

after(async () => {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await writeFile(resolve(output, "server.log"), stderr);
  writeResult(`example-${name}.json`, {
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
  assert.ok(script, "the page links a hashed script");
  const compressed = await raw(script, {
    "accept-encoding": "gzip, deflate, br",
  });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers["content-encoding"], "br");
  assert.equal(compressed.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(compressed.headers.vary, "accept-encoding");
  // Clients without Brotli, such as plain HTTP outside localhost, get it decompressed.
  const plain = await raw(script, { "accept-encoding": "gzip, deflate" });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.deepEqual(brotliDecompressSync(compressed.body), plain.body);
  const cached = await raw(script, {
    "if-none-match": String(plain.headers.etag),
  });
  assert.equal(cached.status, 304);
});

check(
  "SSR renders the workspace, the note tree and Markdown through the JavaScript renderer",
  ["ssr"],
  async () => {
    const home = await fetch(base + "/").then((response) => response.text());
    assert.match(home, /<a class="brand" href="\/">notes<\/a>/);
    assert.match(home, /4 notes/);
    assert.match(home, /href="\/notes\/guide\/getting-started\.md"/);

    const response = await fetch(base + "/notes/index.md");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>Welcome — mdw<\/title>/);
    // Relative links and images are rewritten to workspace routes.
    assert.match(html, /href="\/notes\/guide\/architecture\.md#rendering"/);
    assert.match(html, /src="\/files\/images\/flow\.svg"/);
    assert.match(html, /<li>#fetchlet<\/li>/);
  },
);

check(
  "code blocks are highlighted by syntect in Rust during SSR",
  ["ssr", "internal-fetch"],
  async () => {
    const html = await fetch(base + "/notes/guide/architecture.md").then((r) => r.text());
    assert.match(html, /<code class="language-rust highlighted"><span class="hl-source hl-rust">/);
    assert.match(html, /<code class="language-ts highlighted">/);
    assert.match(html, /<h2 id="rendering">Rendering<\/h2>/);
    const css = await fetch(base + "/api/v1/highlight.css");
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
    assert.match(await css.text(), /prefers-color-scheme: dark/);
  },
);

check("raw HTML in a note is dropped from the rendered page", [], async () => {
  const html = await fetch(base + "/notes/journal/2026-11-17.md").then((r) => r.text());
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Raw HTML is removed when rendering./);
});

check(
  "the public API serves the same typed handlers as the in-process API",
  ["json", "internal-fetch"],
  async () => {
    const listed = await json("/api/v1/notes");
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.map((note: { path: string }) => note.path),
      ["guide/architecture.md", "guide/getting-started.md", "index.md", "journal/2026-11-17.md"],
    );
    const search = await json("/api/v1/search?q=" + encodeURIComponent("日本語"));
    assert.equal(search.body[0].path, "journal/2026-11-17.md");
    assert.deepEqual(
      search.body[0].snippet
        .filter((part: { matched: boolean }) => part.matched)
        .map((part: { text: string }) => part.text),
      ["日本語"],
    );
    const note = await json("/api/v1/note?path=index.md");
    assert.equal(note.body.title, "Welcome");
    assert.match(note.body.version, /^[0-9a-f]{64}$/);
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
    assert.equal(saved.status, 200);
    const stale = await put("lost", note.version);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.conflict.current_version, saved.body.version);
    const created = await put("# exists", null);
    assert.equal(created.status, 409);
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
    assert.equal(response.status, 400, path);
  }
  for (const path of [
    "/files/..%2fsecret.md",
    "/files/%2e%2e/secret.md",
    "/files/guide/..%2f..%2fsecret.md",
  ]) {
    const response = await fetch(base + path);
    assert.notEqual(response.status, 200, path);
    assert.doesNotMatch(await response.text(), /Secret/, path);
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
  assert.equal(put.status, 400);
});

check("workspace files are served sandboxed", [], async () => {
  const response = await fetch(base + "/files/images/flow.svg");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox/);
});

check("requests for another host name are refused", [], async () => {
  assert.equal(await withHost(new URL(base).host, "/"), 200);
  assert.equal(await withHost("rebound.example:80", "/"), 421);
  assert.equal(await withHost("localhost:1", "/api/v1/notes"), 421);
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
    assert.match((await suggestion.textContent()) ?? "", /How it works/);
    assert.equal(await browserPage.locator(".suggestions mark").first().textContent(), "syntect");

    await browserPage.getByRole("searchbox").press("Escape");
    await browserPage.locator(".suggestions").waitFor({ state: "detached" });
    await browserPage.evaluate(
      () => ((window as unknown as Record<string, unknown>).__marker = true),
    );
    await browserPage.locator(".tree").getByRole("link", { name: "Getting started" }).click();
    await browserPage.waitForURL(/getting-started\.md$/);
    await browserPage.locator("h1", { hasText: "Getting started" }).waitFor();
    // Client navigation keeps the same document.
    assert.equal(
      await browserPage.evaluate(() => (window as unknown as Record<string, unknown>).__marker),
      true,
    );
    assert.deepEqual(browserPage.errors, []);
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
    assert.equal(await browserPage.locator(".status").textContent(), "Unsaved changes");

    await browserPage.keyboard.press("Control+s");
    await browserPage.waitForURL(/\/notes\/guide\/architecture\.md$/);
    await browserPage.locator(".markdown h2", { hasText: "Preview heading" }).waitFor();
    const saved = await readFile(resolve(notes, "guide/architecture.md"), "utf8");
    assert.ok(saved.startsWith("## Preview heading\n"), saved.slice(0, 80));
    assert.deepEqual(browserPage.errors, []);
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
  assert.match(
    (await browserPage.getByRole("alert").textContent()) ?? "",
    /changed after it was loaded/,
  );
  await browserPage.getByRole("button", { name: "Overwrite with this version" }).click();
  await browserPage.waitForURL(/\/notes\/journal\/2026-11-17\.md$/);
  const saved = await readFile(resolve(notes, "journal/2026-11-17.md"), "utf8");
  assert.match(saved, /Appended in the browser/);
  assert.doesNotMatch(saved, /Another change/);
});

check(
  "new notes are created through a validated remote form",
  ["form", "server-functions"],
  async () => {
    const browserPage = await page();
    await browserPage.goto(base + "/new");
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
    assert.equal(created, "# café-plan\n\n");
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
  assert.ok(((await browserPage.locator(".markdown").textContent()) ?? "").length > 0);
});
