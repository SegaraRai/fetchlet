import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { exportedHandler, exportedHandlerSource } from "./exported-handler.ts";
import { buildArtifact } from "./index.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
  directory = undefined;
});

describe("exportedHandler", () => {
  test("wraps the default export's fetch and reexports the named exports", () => {
    const source = exportedHandlerSource(String.raw`C:\app\server.ts`);
    expect(source).toContain('import * as server from "C:/app/server.ts"');
    expect(source).toContain('export * from "C:/app/server.ts"');
    expect(source).toContain("export const handle = createFetchHandler(");
    expect(source).toMatch(/handler\.fetch\(request, getBindings\(\), \{\s*waitUntil,/);
    expect(source).toContain("clientAddress: context.clientAddress");
  });

  test("resolves imports from the module's directory", () => {
    directory = mkdtempSync(join(tmpdir(), "fetchlet-exported-"));
    const entry = exportedHandler(join(directory, "src", "server.ts"));
    expect(entry.resolveDir).toBe(join(directory, "src"));
  });

  test("builds an artifact whose exports are the handler and the module's functions", async () => {
    directory = mkdtempSync(join(tmpdir(), "fetchlet-exported-"));
    writeFileSync(
      join(directory, "server.js"),
      `export default { fetch: () => new Response("ok") };
       export function greet(name) { return "hi " + name; }`,
    );
    const outDir = join(directory, "out");
    await buildArtifact({ entry: exportedHandler(join(directory, "server.js")), outDir });
    const server = readFileSync(join(outDir, "server.js"), "utf8");
    expect(server).toMatch(/var fetchletExports = \(function/);
    expect(server).toMatch(/exports\.greet = greet;/);
    expect(server).toMatch(/exports\.handle = handle;/);
    const manifest = JSON.parse(readFileSync(join(outDir, "fetchlet.json"), "utf8"));
    expect(manifest.handler).toBe("handle");
    expect(manifest.framework).toBeUndefined();
  });
});
