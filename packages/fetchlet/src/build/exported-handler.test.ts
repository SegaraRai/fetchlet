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
  test("refers to the module with forward slashes", () => {
    expect(exportedHandlerSource(String.raw`C:\app\server.ts`)).toBe(
      'export * from "fetchlet:exported-handler:C:/app/server.ts";\n',
    );
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
    expect(server).toMatch(/\.fetch\(request, getBindings\(\), \{\s*waitUntil,/);
    expect(server).toContain("clientAddress: context.clientAddress");
    const manifest = JSON.parse(readFileSync(join(outDir, "fetchlet.json"), "utf8"));
    expect(manifest.handler).toBe("handle");
    expect(manifest.functions).toStrictEqual(["greet"]);
    expect(manifest.framework).toBeUndefined();
  });

  test("builds a module without a default export into an artifact of functions only", async () => {
    directory = mkdtempSync(join(tmpdir(), "fetchlet-exported-"));
    writeFileSync(join(directory, "more.js"), "export const sum = (a, b) => a + b;");
    writeFileSync(
      join(directory, "functions.js"),
      `export function greet(name) { return "hi " + name; }
       export * from "./more.js";`,
    );
    const outDir = join(directory, "out");
    await buildArtifact({ entry: exportedHandler(join(directory, "functions.js")), outDir });
    const server = readFileSync(join(outDir, "server.js"), "utf8");
    expect(server).not.toMatch(/exports\.handle =/);
    expect(server).not.toContain("createFetchHandler");
    const manifest = JSON.parse(readFileSync(join(outDir, "fetchlet.json"), "utf8"));
    expect(manifest.handler).toBeNull();
    expect(manifest.functions).toStrictEqual(["greet", "sum"]);
  });

  test("refuses a module that exports the reserved name handle", async () => {
    directory = mkdtempSync(join(tmpdir(), "fetchlet-exported-"));
    writeFileSync(
      join(directory, "server.js"),
      `export default { fetch: () => new Response("ok") };
       export function handle() {}`,
    );
    await expect(
      buildArtifact({
        entry: exportedHandler(join(directory, "server.js")),
        outDir: join(directory, "out"),
      }),
    ).rejects.toThrow(/exports "handle", which is reserved for the Fetch handler/);
  });
});
