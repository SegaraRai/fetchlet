import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildArtifact } from "../build/index.mjs";

const modulePath = (file) => file.replaceAll("\\", "/");

/**
 * Runs Waku's static generation, then builds the RSC server into a fetchlet
 * artifact and copies the public files to `client/` beside it.
 */
export default async function buildEnhancer(build) {
  return async (utils, options) => {
    await build(utils, options);
    const { distDir, fetchlet = {} } = options;
    const { outDir = "build", backend = "portable", intl = {} } = fetchlet;
    const root = process.cwd();
    const serverModule = resolve(root, distDir, "server", "index.js");
    if (!existsSync(serverModule)) {
      throw new Error("fetchlet/waku found no server build at " + serverModule);
    }
    const entry = resolve(root, distDir, "server", "fetchlet.mjs");
    writeFileSync(
      entry,
      `
      import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
      import { INTERNAL_runFetch } from ${JSON.stringify(modulePath(serverModule))};

      const env = getBindings();

      export const handle = createFetchHandler((request, context = {}) =>
        INTERNAL_runFetch(env, request, { clientAddress: context.clientAddress, env, waitUntil }),
      );
      `,
    );
    const output = resolve(root, outDir);
    await buildArtifact({
      entry,
      outDir: output,
      framework: "waku",
      rendering: "streaming",
      asyncContext: "serialized",
      backend,
      intl,
    });
    const client = join(output, "client");
    rmSync(client, { recursive: true, force: true });
    cpSync(resolve(root, distDir, "public"), client, { recursive: true });
  };
}
