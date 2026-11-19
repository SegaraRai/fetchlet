// The harness of an example's `dev:vite` loop: starts `vite dev` in the
// example and its Rust server, built with the `vite-dev` feature, against
// it, registers checks with Vitest, and records
// results/example-<name>-vite-dev.json. Checks edit the example's sources
// in place with `edit`, which every check restores when it ends.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { exampleBinary, root } from "@fetchlet-internal/tools-workspace/paths";
import {
  describe,
  environment,
  summarize,
  writeResult,
} from "@fetchlet-internal/tools-workspace/results";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import type { Feature } from "./features.ts";
import { backend, resultFile } from "./suite.ts";

export interface ViteDevOptions {
  /** Engines the loop does not run on, with the reason; checks are skipped. */
  unsupported?: Partial<Record<string, string>>;
}

export interface ViteDevSuite {
  /** The Rust server's origin, available once the suite's `before` hook ran. */
  readonly base: string;
  /** Registers a check that records its outcome and restores edited files. */
  check: (name: string, features: Feature[], operation: () => Promise<void>) => void;
  /** Opens a Chromium page; the suite closes the browser at the end. */
  page(): Promise<Page>;
  /** Replaces `from` with `to` in a file of the example until the check ends. */
  edit(file: string, from: string, to: string): Promise<void>;
  /** How long an edit may take to show, for `expect.poll`'s `timeout`. */
  readonly deadline: number;
  /** Waits until `condition` holds, failing with the servers' output. */
  until(condition: () => Promise<boolean>, label: string): Promise<void>;
}

const windows = process.platform === "win32";

/** How long an edit may take to show. */
const deadlineMs = 30_000;

/**
 * How long the first page may take: its request evaluates every server
 * module, which takes Boa's debug builds about half a minute for a framework.
 */
const startupMs = 150_000;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

function stop(child: ChildProcess | undefined): Promise<unknown> | undefined {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return undefined;
  }
  const exited = once(child, "exit");
  if (windows) {
    // Vite runs under a shell; the tree goes with it.
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
  } else {
    child.kill();
  }
  return exited;
}

export function viteDevSuite(name: string, options: ViteDevOptions = {}): ViteDevSuite {
  const unsupported = options.unsupported?.[backend];
  if (unsupported !== undefined) {
    return skippedSuite(`${backend}: ${unsupported}`);
  }
  const example = resolve(root, "examples", name);
  const output = resolve(root, ".cache", name, "vite-dev");
  const results: {
    name: string;
    features: Feature[];
    status: "pass" | "fail";
    error?: string;
  }[] = [];
  const originals = new Map<string, string>();
  let vite: ChildProcess | undefined;
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  let base: string | undefined;
  let log = "";

  async function until(
    condition: () => Promise<boolean>,
    label: string,
    timeoutMs = deadlineMs,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition().catch(() => false))) {
      if (Date.now() > deadline) {
        throw new Error(`${label} deadline: ${log}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }

  async function restore(): Promise<void> {
    for (const [file, source] of originals) {
      await writeFile(file, source);
    }
    originals.clear();
  }

  beforeAll(async () => {
    await mkdir(output, { recursive: true });
    const vitePort = await freePort();
    const viteUrl = `http://127.0.0.1:${vitePort}`;
    // `vp` is a `.cmd` shim on Windows, which only a shell can start; the
    // command is one string, since a shell does not escape separate arguments.
    vite = spawn(`vp dev --host 127.0.0.1 --port ${vitePort} --strictPort`, {
      cwd: example,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FETCHLET_BACKEND: backend },
    });
    vite.stdout!.on("data", (data) => (log += data));
    vite.stderr!.on("data", (data) => (log += data));
    await until(async () => (await fetch(`${viteUrl}/@vite/client`)).ok, "Vite startup");

    const config = JSON.parse(await readFile(resolve(example, "config.json"), "utf8"));
    config.listen = "127.0.0.1:0";
    config.backend = backend;
    // The first request loads every module from Vite.
    config.invocation_timeout_ms = Math.max(config.invocation_timeout_ms ?? 0, startupMs);
    const configPath = resolve(output, "config.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));
    const started = spawn(exampleBinary(name), [configPath], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FETCHLET_VITE_URL: viteUrl },
    });
    server = started;
    started.stderr.on("data", (data) => (log += data));
    base = await new Promise<string>((resolveAddress, reject) => {
      started.once("exit", (code) => reject(new Error(`Server exited ${code}: ${log}`)));
      createInterface({
        input: started.stdout,
      }).on("line", (line) => {
        if (line.startsWith("FETCHLET_LISTENING ")) {
          resolveAddress(line.slice("FETCHLET_LISTENING ".length));
        }
      });
    });
    // Vite optimizes the server's dependencies on the first request.
    await until(async () => (await fetch(base + "/")).status < 500, "first page", startupMs);
  }, startupMs + 60_000);

  afterAll(async () => {
    await restore();
    await browser?.close();
    await Promise.all([stop(server), stop(vite)]);
    await writeFile(resolve(output, "server.log"), log);
    writeResult(resultFile(`${name}-vite-dev`), {
      environment: environment({ packagesOf: example }),
      backend,
      browser: browser?.version(),
      summary: summarize(results),
      results,
    });
  });

  return {
    deadline: deadlineMs,
    get base() {
      if (base === undefined) {
        throw new Error("The example server has not started");
      }
      return base;
    },
    check(checkName, features, operation) {
      test(checkName, { timeout: 60_000 }, async () => {
        try {
          await operation();
          results.push({
            name: checkName,
            features,
            status: "pass",
          });
        } catch (error) {
          results.push({
            name: checkName,
            features,
            status: "fail",
            error: describe(error),
          });
          throw error;
        } finally {
          await restore();
        }
      });
    },
    async page() {
      browser ??= await chromium.launch({
        headless: true,
        channel: process.env.FETCHLET_BROWSER_CHANNEL || undefined,
      });
      const opened = await browser.newPage();
      opened.setDefaultTimeout(30_000);
      return opened;
    },
    async edit(file, from, to) {
      const path = resolve(example, file);
      const source = await readFile(path, "utf8");
      if (!originals.has(path)) {
        originals.set(path, source);
      }
      expect(source).toContain(from);
      await writeFile(path, source.replace(from, to));
    },
    until,
  };
}

/** A suite whose checks are all skipped, without servers or a result file. */
function skippedSuite(reason: string): ViteDevSuite {
  const unavailable = () => {
    throw new Error(reason);
  };
  return {
    deadline: deadlineMs,
    get base(): string {
      return unavailable();
    },
    check(checkName) {
      test.skip(`${checkName} (${reason})`, () => {});
    },
    page: unavailable,
    edit: unavailable,
    until: unavailable,
  };
}
