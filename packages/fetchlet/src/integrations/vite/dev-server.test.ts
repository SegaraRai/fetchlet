import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, isRunnableDevEnvironment, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { devServerPlugin } from "./dev-server.ts";
import fetchlet from "./index.ts";

let directory: string;
let vite: ViteDevServer;
let http: Server;
let origin: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-vite-dev-"));
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src/message.ts"), 'export const message = "first";\n');
  writeFileSync(
    join(directory, "src/server.ts"),
    [
      'import { message } from "./message.ts";',
      "export default { fetch: () => new Response(message) };",
      "export function greet(name: string) { return `${message} ${name}`; }",
      "",
    ].join("\n"),
  );
  writeFileSync(join(directory, "src/client.ts"), "export {};\n");
  vite = await createServer({
    root: directory,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, ws: false, watch: null },
    plugins: [fetchlet({ client: "src/client.ts", backend: "quickjs" })],
  });
  http = createHttpServer(vite.middlewares);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => http.close(resolve));
  await vite.close();
  rmSync(directory, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) => {
  const response = await fetch(origin + path, { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json();
};

describe("fetchlet/vite development serving", () => {
  test("builds a development artifact over the server module's exports", async () => {
    const manifest = await (await fetch(`${origin}/@fetchlet/artifact/fetchlet.json`)).json();
    expect(manifest).toMatchObject({ handler: "handle", functions: ["greet"], backend: "quickjs" });
    const server = await (await fetch(`${origin}/@fetchlet/artifact/server.js`)).text();
    expect(server).toContain("fetchletExports");
    expect(server).toContain('"/src/server.ts"');
  }, 60_000);

  test("answers the module runner as the ssr environment's transport", async () => {
    const result = await post("/@fetchlet/invoke", {
      type: "custom",
      event: "vite:invoke",
      data: { id: "send:1", name: "fetchModule", data: ["/src/server.ts", undefined, {}] },
    });
    expect(result.result.code).toContain("__vite_ssr_exportName__");
  });

  test("lists changed server modules with their importers", async () => {
    const before = await post("/@fetchlet/updates", { since: null });
    expect(before.invalidated).toStrictEqual([]);
    await vite.environments.ssr!.transformRequest("/src/server.ts");
    const file = join(directory, "src/message.ts");
    writeFileSync(file, 'export const message = "second";\n');
    vite.watcher.emit("change", file);
    await expect
      .poll(async () => (await post("/@fetchlet/updates", { since: before.version })).invalidated)
      .toEqual(
        expect.arrayContaining([
          expect.stringMatching(/src\/message\.ts$/),
          expect.stringMatching(/src\/server\.ts$/),
        ]),
      );
    const latest = await post("/@fetchlet/updates", { since: before.version + 1 });
    expect(latest.invalidated).toStrictEqual([]);
  });

  test("serves a browser entry with Vite's HMR client", async () => {
    const response = await fetch(`${origin}/@fetchlet/client?entry=src%2Fclient.ts`);
    expect(await response.text()).toBe('import "/@vite/client";\nimport "/src/client.ts";\n');
  });
});

describe("a non-runnable server environment", () => {
  test("is fetchable, keeps every module internal and still answers the runner", async () => {
    const server = await createServer({
      root: directory,
      configFile: false,
      logLevel: "silent",
      server: {
        middlewareMode: true,
        ws: false,
        watch: null,
      },
      plugins: [
        devServerPlugin({
          name: "test:dev-server",
          entry: "src/server.ts",
          runnable: false,
          framework: "test",
          rendering: "buffered",
        }),
      ],
    });
    try {
      const ssr = server.environments.ssr!;
      // Frameworks that render in Node whenever the environment is
      // runnable, such as React Router, leave its requests to the host.
      expect(isRunnableDevEnvironment(ssr)).toBe(false);
      expect("dispatchFetch" in ssr).toBe(true);
      expect(ssr.config.resolve.noExternal).toBe(true);
      const result = (await ssr.hot.handleInvoke({
        type: "custom",
        event: "vite:invoke",
        data: {
          id: "send:1",
          name: "fetchModule",
          data: ["/src/server.ts", undefined, {}],
        },
      })) as {
        result: {
          code: string;
        };
      };
      expect(result.result.code).toContain("__vite_ssr_exportName__");
    } finally {
      await server.close();
    }
  });
});
