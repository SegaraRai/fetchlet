// `mdw serve` over real HTTP and a real browser: SSR, hydration, remote
// functions, the typed Rust API, live updates and the workspace boundary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const name = "sveltekit-axum-tauri";
const root = resolve(import.meta.dirname, "../../..");
const example = resolve(root, "examples", name);
const output = resolve(root, ".cache", name, "e2e");
const notes = resolve(output, "notes");
const results = [];
let child;
let browser;
let base;
let stderr = "";

before(async () => {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(resolve(example, "sample"), notes, { recursive: true });
  // A file outside the workspace that no request may read.
  await writeFile(resolve(output, "secret.md"), "# Secret\n");
  const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
  config.build_directory = resolve(example, "build");
  if (process.env.FETCHLET_BACKEND) config.backend = process.env.FETCHLET_BACKEND;
  const configPath = resolve(output, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const executable = resolve(
    root,
    "target/debug/mdw" + (process.platform === "win32" ? ".exe" : ""),
  );
  child = spawn(executable, ["--config", configPath, "serve", notes, "--listen", "127.0.0.1:0"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (data) => (stderr += data));
  const lines = createInterface({ input: child.stdout });
  base = await new Promise((resolveAddress, reject) => {
    const failed = (error) => {
      clearTimeout(deadline);
      reject(error);
    };
    const deadline = setTimeout(() => failed(new Error("startup deadline: " + stderr)), 20000);
    child.once("error", failed);
    child.once("exit", (code) => failed(new Error("mdw exited " + code + ": " + stderr)));
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
  await mkdir(resolve(root, "results"), { recursive: true });
  await writeFile(resolve(output, "server.log"), stderr);
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
  test(label, { timeout: 30000 }, async () => {
    try {
      await operation();
      results.push({ name: label, status: "pass" });
    } catch (error) {
      results.push({ name: label, status: "fail", error: String(error.stack ?? error) });
      throw error;
    }
  });
}

async function page(options = {}) {
  browser ??= await chromium.launch({
    headless: true,
    channel: process.env.FETCHLET_BROWSER_CHANNEL || undefined,
  });
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  page.errors = errors;
  return page;
}

async function json(path, init) {
  const response = await fetch(base + path, init);
  return { status: response.status, body: await response.json() };
}

/** A raw request with a chosen Host header, which fetch does not allow. */
function withHost(host, path) {
  const url = new URL(path, base);
  return new Promise((resolveStatus, reject) => {
    const outgoing = request(
      { host: url.hostname, port: url.port, path: url.pathname, headers: { host } },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

check(
  "SSR renders the workspace, the note tree and Markdown through the JavaScript renderer",
  async () => {
    const home = await fetch(base + "/").then((response) => response.text());
    assert.match(home, /<a class="brand" href="\/">notes<\/a>/);
    assert.match(home, /4 件のノート/);
    assert.match(home, /href="\/notes\/guide\/getting-started\.md"/);

    const response = await fetch(base + "/notes/index.md");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>ようこそ — mdw<\/title>/);
    // Relative links and images are rewritten to workspace routes.
    assert.match(html, /href="\/notes\/guide\/architecture\.md#rendering"/);
    assert.match(html, /src="\/files\/images\/flow\.svg"/);
    assert.match(html, /<li>#fetchlet<\/li>/);
  },
);

check("code blocks are highlighted by syntect in Rust during SSR", async () => {
  const html = await fetch(base + "/notes/guide/architecture.md").then((r) => r.text());
  assert.match(html, /<code class="language-rust highlighted"><span class="hl-source hl-rust">/);
  assert.match(html, /<code class="language-ts highlighted">/);
  assert.match(html, /<h2 id="rendering">Rendering<\/h2>/);
  const css = await fetch(base + "/api/v1/highlight.css");
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(await css.text(), /prefers-color-scheme: dark/);
});

check("raw HTML in a note is dropped from the rendered page", async () => {
  const html = await fetch(base + "/notes/journal/2026-11-17.md").then((r) => r.text());
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Raw HTML は描画時に取り除かれる。/);
});

check("the public API serves the same typed handlers as the in-process API", async () => {
  const listed = await json("/api/v1/notes");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.map((note) => note.path),
    ["guide/architecture.md", "guide/getting-started.md", "index.md", "journal/2026-11-17.md"],
  );
  const search = await json("/api/v1/search?q=" + encodeURIComponent("日本語"));
  assert.equal(search.body[0].path, "journal/2026-11-17.md");
  assert.deepEqual(
    search.body[0].snippet.filter((part) => part.matched).map((part) => part.text),
    ["日本語"],
  );
  const note = await json("/api/v1/note?path=index.md");
  assert.equal(note.body.title, "ようこそ");
  assert.match(note.body.version, /^[0-9a-f]{64}$/);
});

check("a save based on a stale version is a conflict that names the current version", async () => {
  const { body: note } = await json("/api/v1/note?path=guide/getting-started.md");
  const put = (content, base_version) =>
    json("/api/v1/note", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: note.path, content, base_version }),
    });
  const saved = await put(note.content + "\n追記\n", note.version);
  assert.equal(saved.status, 200);
  const stale = await put("lost", note.version);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict.current_version, saved.body.version);
  const created = await put("# exists", null);
  assert.equal(created.status, 409);
});

check("paths outside the workspace are refused by the API and the file route", async () => {
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
    body: JSON.stringify({ path: "../escape.md", content: "x", base_version: null }),
  });
  assert.equal(put.status, 400);
});

check("workspace files are served sandboxed", async () => {
  const response = await fetch(base + "/files/images/flow.svg");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /^sandbox/);
});

check("requests for another host name are refused", async () => {
  assert.equal(await withHost(new URL(base).host, "/"), 200);
  assert.equal(await withHost("rebound.example:80", "/"), 421);
  assert.equal(await withHost("localhost:1", "/api/v1/notes"), 421);
});

check("the page hydrates, searches with remote functions and navigates on the client", async () => {
  const browserPage = await page();
  await browserPage.goto(base + "/");
  // LocalTime switches from the SSR date to the browser's local format.
  await browserPage.waitForFunction(() =>
    [...document.querySelectorAll("time")].some((time) => time.textContent.length > 10),
  );
  await browserPage.getByRole("searchbox").fill("syntect");
  const suggestion = browserPage.locator(".suggestions a").first();
  await suggestion.waitFor();
  assert.match(await suggestion.textContent(), /しくみ/);
  assert.equal(await browserPage.locator(".suggestions mark").first().textContent(), "syntect");

  await browserPage.getByRole("searchbox").press("Escape");
  await browserPage.locator(".suggestions").waitFor({ state: "detached" });
  await browserPage.evaluate(() => (window.__marker = true));
  await browserPage.locator(".tree").getByRole("link", { name: "はじめに" }).click();
  await browserPage.waitForURL(/getting-started\.md$/);
  await browserPage.locator("h1", { hasText: "はじめに" }).waitFor();
  // Client navigation keeps the same document.
  assert.equal(await browserPage.evaluate(() => window.__marker), true);
  assert.deepEqual(browserPage.errors, []);
});

check("the editor previews through the Rust process and saves with Ctrl+S", async () => {
  const browserPage = await page();
  await browserPage.goto(base + "/notes/guide/architecture.md/edit");
  const editor = browserPage.getByRole("textbox", { name: "Markdown" });
  await editor.waitFor();
  await editor.click();
  await browserPage.keyboard.press("Control+Home");
  await browserPage.keyboard.type("## プレビュー見出し\n\n```rust\nfn preview() {}\n```\n\n");
  const preview = browserPage.locator(".preview");
  await preview.locator("h2", { hasText: "プレビュー見出し" }).waitFor();
  await preview.locator("code.language-rust.highlighted").first().waitFor();
  assert.equal(await browserPage.locator(".status").textContent(), "未保存の変更");

  await browserPage.keyboard.press("Control+s");
  await browserPage.waitForURL(/\/notes\/guide\/architecture\.md$/);
  await browserPage.locator(".markdown h2", { hasText: "プレビュー見出し" }).waitFor();
  const saved = await readFile(resolve(notes, "guide/architecture.md"), "utf8");
  assert.ok(saved.startsWith("## プレビュー見出し\n"), saved.slice(0, 80));
  assert.deepEqual(browserPage.errors, []);
});

check("a change saved outside the browser reaches the open page", async () => {
  const browserPage = await page();
  await browserPage.goto(base + "/notes/index.md");
  await browserPage.locator("h1", { hasText: "ようこそ" }).waitFor();
  await writeFile(resolve(notes, "index.md"), "# 外部で更新\n\n別のエディターから保存した。\n");
  await browserPage.locator("h1", { hasText: "外部で更新" }).waitFor({ timeout: 10000 });
  // The tree shows the new title too.
  await browserPage.locator(".tree a", { hasText: "外部で更新" }).waitFor();
});

check("the editor reports a conflict and can overwrite the version on disk", async () => {
  const browserPage = await page();
  await browserPage.goto(base + "/notes/journal/2026-11-17.md/edit");
  const editor = browserPage.getByRole("textbox", { name: "Markdown" });
  await editor.click();
  await browserPage.keyboard.press("Control+End");
  await browserPage.keyboard.type("\nブラウザーでの追記\n");
  await writeFile(resolve(notes, "journal/2026-11-17.md"), "# 別の変更\n");
  await browserPage.locator(".banner", { hasText: "エディターの外で変更" }).waitFor();
  await browserPage.keyboard.press("Control+s");
  await browserPage.getByRole("alert").waitFor();
  assert.match(await browserPage.getByRole("alert").textContent(), /変更されています/);
  await browserPage.getByRole("button", { name: "この内容で上書き" }).click();
  await browserPage.waitForURL(/\/notes\/journal\/2026-11-17\.md$/);
  const saved = await readFile(resolve(notes, "journal/2026-11-17.md"), "utf8");
  assert.match(saved, /ブラウザーでの追記/);
  assert.doesNotMatch(saved, /別の変更/);
});

check("new notes are created through a validated remote form", async () => {
  const browserPage = await page();
  await browserPage.goto(base + "/new");
  const input = browserPage.getByRole("textbox", { name: /名前/ });
  await input.fill("guide/getting-started");
  await browserPage.getByRole("button", { name: "作成して編集" }).click();
  await browserPage.locator(".error", { hasText: "同じ名前のノートがあります" }).waitFor();

  await input.fill("projects/新しい計画");
  await browserPage.getByRole("button", { name: "作成して編集" }).click();
  await browserPage.waitForURL(/projects\/%E6%96%B0.*\.md\/edit$/);
  const created = await readFile(resolve(notes, "projects/新しい計画.md"), "utf8");
  assert.equal(created, "# 新しい計画\n\n");
  await browserPage.locator(".tree a", { hasText: "新しい計画" }).waitFor();
});

check("search and notes work without JavaScript", async () => {
  const browserPage = await page({ javaScriptEnabled: false });
  await browserPage.goto(base + "/");
  await browserPage.getByRole("searchbox").fill("ワークスペース");
  await browserPage.getByRole("searchbox").press("Enter");
  await browserPage.waitForURL(/\/search\?q=/);
  await browserPage.locator(".results a").first().click();
  await browserPage.waitForURL(/\/notes\//);
  assert.ok((await browserPage.locator(".markdown").textContent()).length > 0);
});
