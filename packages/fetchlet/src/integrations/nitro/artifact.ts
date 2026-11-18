import { rmSync } from "node:fs";
import { join } from "node:path";

import type { Nitro } from "nitropack/types";
import type { Plugin } from "rolldown";

import { type CacheRule } from "../../build/asset-entries.ts";
import { frameworkAssets } from "../../build/asset-option.ts";
import { buildArtifact } from "../../build/index.ts";
import type {} from "./types.d.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

const environmentId = "\0fetchlet:nitro-environment";

/**
 * Nitro's process.env reads globalThis.__env__, also while it initializes the
 * runtime config, so this module runs before Nitro's server bundle.
 */
function nitroEnvironment(): Plugin {
  return {
    name: "fetchlet:nitro-environment",
    resolveId(id) {
      if (id === environmentId) {
        return id;
      }
    },
    load(id) {
      if (id === environmentId) {
        return `
          import { getBindings } from "fetchlet/runtime/adapter";

          globalThis.__env__ = Object.fromEntries(
            Object.entries(getBindings()).filter(([, value]) => typeof value === "string"),
          );
        `;
      }
    },
  };
}

/**
 * Wrap Nitro's server bundle in the fetchlet Fetch entry and write
 * server.js and fetchlet.json next to the public assets.
 */
export async function writeArtifact(nitro: Nitro): Promise<void> {
  const { backend = "portable", intl = {}, assets = false } = nitro.options.fetchlet ?? {};
  const serverDir = nitro.options.output.serverDir;
  const entrySource = `
    import ${JSON.stringify(environmentId)};
    import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
    import { handler } from ${JSON.stringify(modulePath(join(serverDir, "index.mjs")))};

    const fetchlet = { env: getBindings() };

    export const handle = createFetchHandler((request, context = {}) => {
      // Nitro copies _platform into the context of nested $fetch events.
      const platform = { clientAddress: context.clientAddress, fetchlet };
      return handler(request, { ...platform, _platform: platform, waitUntil });
    });
    `;
  // fetchlet.json replaces Nitro's build information in the artifact.
  rmSync(join(nitro.options.output.dir, "nitro.json"), { force: true });
  await buildArtifact({
    entry: {
      source: entrySource,
      resolveDir: serverDir,
    },
    plugins: [nitroEnvironment()],
    outDir: nitro.options.output.dir,
    framework: nitro.options.framework.name || "nitro",
    rendering: "buffered",
    backend,
    intl,
    ...(assets
      ? {
          assets: frameworkAssets(assets, {
            cache: publicAssetCache(nitro),
          }),
        }
      : {}),
  });
}

/**
 * `Cache-Control` for Nitro's public asset directories that set `maxAge`,
 * such as Nuxt's hashed `/_nuxt/` build output.
 */
function publicAssetCache(nitro: Nitro): CacheRule[] {
  return nitro.options.publicAssets
    .filter((asset) => asset.maxAge)
    .map((asset) => ({
      prefix: (asset.baseURL ?? "/").replace(/\/?$/, "/"),
      cacheControl: `public, max-age=${asset.maxAge}, immutable`,
    }));
}
