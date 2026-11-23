import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRequestEvent } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { buildArtifact } from "../../build/index.ts";
import { getRequestContext } from "./context.ts";
import fetchletSolid from "./index.ts";

vi.mock(import("../../build/index.ts"), () => ({
  buildArtifact: vi.fn(),
}));
// The workspace resolves @solidjs/web against SolidStart's Solid 1; apps load it with Solid 2.
vi.mock(
  import("@solidjs/web"),
  () =>
    ({
      getRequestEvent: vi.fn(),
    }) as never,
);

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fetchlet-solid-"));
  vi.mocked(buildArtifact).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

type Hook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: object, name: string) => (plugin as Record<string, Hook>)[name]!;

describe("fetchlet/solid", () => {
  test("resolves Solid libraries from source and Web-standard builds", () => {
    const plugin = fetchletSolid();
    const config = hook(plugin, "config").call({}) as { environments: Record<string, any> };
    expect(config.environments.ssr.resolve.conditions.slice(0, 3)).toStrictEqual([
      "solid",
      "fetchlet",
      "worker",
    ]);
  });

  test("passes the request context to handleRequest on the request event", async () => {
    writeFileSync(join(directory, "server.js"), "");
    const plugin = fetchletSolid();
    hook(plugin, "configResolved").call(
      {},
      {
        root: directory,
        base: "/",
        build: {
          assetsDir: "assets",
        },
      },
    );
    await hook(plugin, "writeBundle").call(
      {},
      {
        dir: directory,
      },
      {
        server: {
          type: "chunk",
          fileName: "server.js",
          name: "server",
          isEntry: true,
        },
      },
    );
    const options = vi.mocked(buildArtifact).mock.lastCall![0];
    expect(options).toMatchObject({
      framework: "solid",
      asyncContext: "serialized",
    });
    const source = (options.entry as { source: string }).source;
    expect(source).toContain("import { handleRequest } from");
    expect(source).toMatch(
      /event: \{\s*fetchlet: \{\s*clientAddress: context\.clientAddress,\s*env,\s*waitUntil,?\s*\},?\s*\}/,
    );
  });
});

describe("getRequestContext", () => {
  test("reads the context from the request event", () => {
    const context = {
      env: {},
      waitUntil() {},
    };
    expect(
      getRequestContext({
        fetchlet: context,
      }),
    ).toBe(context);
  });

  test("reads the current request event by default", () => {
    const context = {
      env: {},
      waitUntil() {},
    };
    vi.mocked(getRequestEvent).mockReturnValueOnce({
      fetchlet: context,
    } as never);
    expect(getRequestContext()).toBe(context);
  });

  test("throws outside a fetchlet request", () => {
    expect(() => getRequestContext({})).toThrow(/inside a fetchlet request/);
    vi.mocked(getRequestEvent).mockReturnValueOnce(undefined);
    expect(() => getRequestContext()).toThrow(/inside a fetchlet request/);
  });
});
