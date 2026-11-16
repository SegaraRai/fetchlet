import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { before, after, test } from "node:test";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");

export function exampleSuite(name) {
  const example = resolve(root, "examples", name);
  const output = resolve(root, ".cache", name);
  const results = [];
  let child;
  let browser;
  let base;
  let stderr = "";

  before(async () => {
    await mkdir(output, { recursive: true });
    const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
    config.listen = "127.0.0.1:0";
    config.build_directory = resolve(example, "build");
    config.request_body_bytes = 4096;
    const configPath = resolve(output, "config.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));

    child = spawn(
      resolve(root, "target/debug/example-" + name + (process.platform === "win32" ? ".exe" : "")),
      [configPath],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const lines = createInterface({ input: child.stdout });
    base = await new Promise((resolveAddress, reject) => {
      function failed(error) {
        clearTimeout(deadline);
        reject(error);
      }
      const deadline = setTimeout(
        () => failed(new Error("Server startup deadline: " + stderr)),
        20000,
      );
      child.once("error", failed);
      child.once("exit", (code) => failed(new Error("Server exited " + code + ": " + stderr)));
      lines.on("line", (line) => {
        if (line.startsWith("FETCHLET_LISTENING ")) {
          clearTimeout(deadline);
          resolveAddress(line.slice("FETCHLET_LISTENING ".length));
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

  return {
    get base() {
      return base;
    },
    check(name, operation) {
      test(name, { timeout: 30000 }, async () => {
        try {
          await operation();
          results.push({ name, status: "pass" });
        } catch (error) {
          results.push({ name, status: "fail", error: String(error.stack ?? error) });
          throw error;
        }
      });
    },
    async page() {
      browser ??= await chromium.launch({
        headless: true,
        channel: process.env.FETCHLET_BROWSER_CHANNEL || undefined,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      return page;
    },
  };
}
