import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "rolldown";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { implementedNodeBuiltins, nodeBuiltins, nodeGlobals } from "./node-builtins.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
  directory = undefined;
});

/**
 * Bundle `files` with the plugin as fetchlet/build configures it, evaluate
 * the bundle in this process and return what its entry exports as `result`.
 */
async function run(files: Record<string, string>, asyncContext?: "serialized"): Promise<unknown> {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-node-"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(directory, name), text);
  }
  const bundle = await build({
    input: join(directory, "entry.js"),
    platform: "neutral",
    plugins: [nodeBuiltins(asyncContext)],
    transform: {
      inject: nodeGlobals,
    },
    write: false,
    output: {
      format: "iife",
      name: "exports",
      codeSplitting: false,
    },
  });
  const code = bundle.output[0].code;
  return new Function(`${code}; return exports.result;`)();
}

describe("nodeBuiltins", () => {
  test("lists each implemented module with and without the node: scheme", () => {
    expect(implementedNodeBuiltins).toContain("node:crypto");
    expect(implementedNodeBuiltins).toContain("crypto");
    expect(implementedNodeBuiltins).toContain("node:async_hooks");
    expect(implementedNodeBuiltins).not.toContain("node:fs");
  });

  test("imports and requires reach the same module, and require returns its default export", async () => {
    const result = await run({
      "entry.js": `
        import { EventEmitter } from "node:events";
        import cjs from "./cjs.cjs";
        export const result = [
          cjs.events === EventEmitter,
          typeof cjs.events.once,
          new cjs.events() instanceof EventEmitter,
          cjs.path.join("/a", "..", "b"),
          cjs.util.format("%s=%d", "x", 1),
        ];
      `,
      "cjs.cjs": `
        module.exports = {
          events: require("events"),
          path: require("node:path"),
          util: require("util"),
        };
      `,
    });
    expect(result).toStrictEqual([true, "function", true, "/b", "x=1"]);
  });

  test("injects Buffer, process and setImmediate only where they are referenced", async () => {
    const result = await run({
      "entry.js": `
        export const result = [
          Buffer.from("hi").toString("base64url"),
          process.versions.node,
          typeof setImmediate,
        ];
      `,
    });
    expect(result).toStrictEqual(["aGk", undefined, "function"]);
  });

  test("other built-ins load as stubs that throw when used", async () => {
    const result = (await run({
      "entry.js": `
        import { readFileSync } from "node:fs";
        const { Socket } = require("net");
        class Custom extends Socket {}
        const attempt = (run) => {
          try {
            run();
          } catch (error) {
            return [error.code, error.message];
          }
        };
        export const result = [
          attempt(() => readFileSync("/file")),
          attempt(() => new Custom()),
        ];
      `,
    })) as unknown[];
    expect(result).toStrictEqual([
      ["ERR_METHOD_NOT_IMPLEMENTED", "node:fs.readFileSync is not available in fetchlet"],
      ["ERR_METHOD_NOT_IMPLEMENTED", "node:net.Socket is not available in fetchlet"],
    ]);
  });

  test("node:stream bundles readable-stream with the artifact's process and string_decoder", async () => {
    const result = await run({
      "entry.js": `
        import { Readable, Transform } from "node:stream";
        export const result = new Promise((resolve) => {
          const chunks = [];
          Readable.from(["fetch", "let"])
            .pipe(new Transform({ transform: (chunk, _, done) => done(null, String(chunk).toUpperCase()) }))
            .setEncoding("utf8")
            .on("data", (chunk) => chunks.push(chunk))
            .on("end", () => resolve(chunks.join("")));
        });
      `,
    });
    expect(await result).toBe("FETCHLET");
  });

  test("node:async_hooks follows asyncContext", async () => {
    const entry = {
      "entry.js": `
        import { AsyncLocalStorage } from "node:async_hooks";
        let result;
        try {
          const storage = new AsyncLocalStorage();
          result = storage.run("store", () => storage.getStore());
        } catch (error) {
          result = error.message;
        }
        export { result };
      `,
    };
    expect(await run(entry, "serialized")).toBe("store");
    expect(await run(entry)).toBe(
      "node:async_hooks.AsyncLocalStorage is not available in fetchlet; build with the asyncContext option to provide it",
    );
  });
});
