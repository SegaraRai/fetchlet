import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import { fetchletAdapter, type FetchletQwikCityOptions } from "./vite.ts";

vi.mock(import("../../build/index.ts"), () => ({
  buildArtifact: vi.fn(),
}));
vi.mock(import("../../build/asset-option.ts"), () => ({
  frameworkAssets: vi.fn((assets, defaults) => ({ assets, defaults }) as never),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-qwik-city-"));
  vi.mocked(buildArtifact).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: object, name: string) => (plugin as Record<string, Hook>)[name]!;

function plugin(options: FetchletQwikCityOptions, ssr: boolean) {
  const adapter = fetchletAdapter(options);
  hook(adapter, "configResolved").call(
    {},
    {
      root: directory,
      build: {
        ssr,
      },
    },
  );
  return adapter;
}

const entryChunk = (fileName: string, name: string) => ({
  type: "chunk",
  fileName,
  name,
  isEntry: true,
});

describe("fetchlet/qwik-city", () => {
  test("configures only the SSR build, with the entry and the route plan", () => {
    const config = hook(fetchletAdapter({ entry: "src/server.tsx" }), "config");
    expect(config.call({}, {}, { isSsrBuild: false })).toBeUndefined();
    expect(config.call({}, {}, { isSsrBuild: true })).toMatchObject({
      ssr: {
        target: "webworker",
        noExternal: true,
      },
      publicDir: false,
      build: {
        ssr: true,
        rollupOptions: {
          input: ["src/server.tsx", "@qwik-city-plan"],
        },
      },
    });
  });

  test("renames Qwik's client chunk names into ones Rolldown accepts", () => {
    const outputOptions = hook(plugin({}, false), "outputOptions");
    const output = outputOptions.call(
      {},
      {
        manualChunks: (id: string) => (id.endsWith(".css") ? undefined : id),
      },
    ) as { manualChunks(id: string, meta: unknown): string | undefined };
    expect(output.manualChunks("/src/routes/[id]/index.tsx", {})).toBe("_src_routes_id_index_tsx");
    expect(output.manualChunks("/a.css", {})).toBeUndefined();
    expect(outputOptions.call({}, {})).toBeUndefined();
    expect(hook(plugin({}, true), "outputOptions").call({}, { manualChunks: () => "x" })).toBe(
      undefined,
    );
  });

  test("writeBundle does nothing in the client build", async () => {
    await hook(plugin({}, false), "writeBundle").call({}, { dir: directory }, {});
    expect(buildArtifact).not.toHaveBeenCalled();
  });

  test("writeBundle wraps the entry's default export as the Fetch handler", async () => {
    writeFileSync(join(directory, "entry.fetchlet-abc.js"), "");
    await hook(plugin({ assets: true }, true), "writeBundle").call(
      {},
      { dir: directory },
      {
        plan: entryChunk("plan.js", "@qwik-city-plan"),
        entry: entryChunk("entry.fetchlet-abc.js", "entry.fetchlet"),
      },
    );
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    expect(options).toMatchObject({
      outDir: join(directory, "build"),
      framework: "qwik-city",
      asyncContext: "serialized",
      entry: {
        resolveDir: directory,
        source: expect.stringContaining("createFetchHandler(handler)"),
      },
    });
    expect(
      (options.assets as { defaults: { cache: { prefix: string }[] } }).defaults.cache.map(
        (rule) => rule.prefix,
      ),
    ).toStrictEqual(["/assets/", "/build/"]);
  });

  test("writeBundle names the entry it could not find", async () => {
    await expect(
      hook(plugin({ entry: "src/server.tsx" }, true), "writeBundle").call(
        {},
        { dir: directory },
        {},
      ),
    ).rejects.toThrow(`fetchlet/qwik-city found no "server" entry in ${directory}`);
  });
});
