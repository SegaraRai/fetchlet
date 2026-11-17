// The end-to-end harness of a framework example: starts the example's Rust
// server with a test configuration, registers checks with node:test, opens
// Playwright pages on demand and records results/example-<name>.json.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";

import { exampleBinary, root } from "@fetchlet-internal/tools-workspace/paths";
import {
  describe,
  environment,
  summarize,
  writeResult,
} from "@fetchlet-internal/tools-workspace/results";
import { chromium, type Browser, type Page } from "playwright";

import type { Feature } from "./features.ts";

export interface ExampleSuite {
  /** The server origin, available once the suite's `before` hook ran. */
  readonly base: string;
  /** Registers a check that records its outcome in the result file. */
  check(name: string, features: Feature[], operation: () => Promise<void>): void;
  /** Opens a Chromium page; the suite closes the browser at the end. */
  page(): Promise<Page>;
}

export function exampleSuite(name: string): ExampleSuite {
  const example = resolve(root, "examples", name);
  const output = resolve(root, ".cache", name);
  const results: { name: string; features: Feature[]; status: "pass" | "fail"; error?: string }[] =
    [];
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let base: string | undefined;
  let stderr = "";

  before(async () => {
    await mkdir(output, { recursive: true });
    const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
    config.listen = "127.0.0.1:0";
    config.build_directory = resolve(example, "build");
    config.request_body_bytes = 4096;
    const configPath = resolve(output, "config.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const server = spawn(exampleBinary(name), [configPath], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = server;
    server.stderr.on("data", (data) => {
      stderr += data;
    });
    const lines = createInterface({ input: server.stdout });
    base = await new Promise<string>((resolveAddress, reject) => {
      function failed(error: Error): void {
        clearTimeout(deadline);
        reject(error);
      }
      const deadline = setTimeout(
        () => failed(new Error("Server startup deadline: " + stderr)),
        20_000,
      );
      server.once("error", failed);
      server.once("exit", (code) => failed(new Error("Server exited " + code + ": " + stderr)));
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
    await writeFile(resolve(output, "server.log"), stderr);
    writeResult(`example-${name}.json`, {
      environment: environment({ packagesOf: example }),
      browser: browser?.version(),
      summary: summarize(results),
      results,
    });
  });

  return {
    get base() {
      if (base === undefined) throw new Error("The example server has not started");
      return base;
    },
    check(checkName, features, operation) {
      test(checkName, { timeout: 30_000 }, async () => {
        try {
          await operation();
          results.push({ name: checkName, features, status: "pass" });
        } catch (error) {
          results.push({ name: checkName, features, status: "fail", error: describe(error) });
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
      page.setDefaultTimeout(10_000);
      return page;
    },
  };
}
