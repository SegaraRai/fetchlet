import { existsSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import { archiveArtifactAssets, frameworkAssets } from "../../build/asset-option.ts";
import { buildArtifact } from "../../build/index.ts";
import type { FetchletWakuOptions } from "./adapter.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

/**
 * Runs Waku's static generation, then builds the RSC server into a fetchlet
 * artifact and moves the public files to `client/` beside it. Waku loads it
 * by name from `buildEnhancers`; apps do not call it.
 */
export default async function buildEnhancer<Build extends (...args: never[]) => Promise<void>>(
  build: Build,
): Promise<Build> {
  const enhanced = async (
    utils: unknown,
    options: { distDir: string; fetchlet?: FetchletWakuOptions },
  ): Promise<void> => {
    await (build as unknown as (utils: unknown, options: unknown) => Promise<void>)(utils, options);
    const { distDir, fetchlet = {} } = options;
    const { outDir = "build", backend = "portable", intl = {}, assets = false } = fetchlet;
    const root = process.cwd();
    const serverModule = resolve(root, distDir, "server", "index.js");
    if (!existsSync(serverModule)) {
      throw new Error("fetchlet/waku found no server build at " + serverModule);
    }
    const entrySource = `
      import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
      import { INTERNAL_runFetch } from ${JSON.stringify(modulePath(serverModule))};

      const env = getBindings();

      export const handle = createFetchHandler((request, context = {}) =>
        INTERNAL_runFetch(env, request, { clientAddress: context.clientAddress, env, waitUntil }),
      );
      `;
    const output = resolve(root, outDir);
    await buildArtifact({
      entry: {
        source: entrySource,
        resolveDir: resolve(root, distDir, "server"),
      },
      outDir: output,
      framework: "waku",
      rendering: "streaming",
      asyncContext: "serialized",
      backend,
      intl,
    });
    const client = join(output, "client");
    rmSync(client, { recursive: true, force: true });
    // Waku writes the client build and generated pages to distDir/public, a
    // name it fixes, and needs nothing there after the build: move it.
    renameSync(resolve(root, distDir, "public"), client);
    if (assets) {
      await archiveArtifactAssets({
        outDir: output,
        assets: frameworkAssets(assets, {
          cache: [{ prefix: "/assets/", cacheControl: IMMUTABLE }],
        }),
      });
    }
  };
  return enhanced as unknown as Build;
}
