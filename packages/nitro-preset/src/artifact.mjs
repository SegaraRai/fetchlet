import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArtifact } from "@fetchlet/build";

const modulePath = (file) => file.replaceAll("\\", "/");

/**
 * Wrap Nitro's server bundle in the fetchlet Fetch entry and write
 * server.js and fetchlet.json next to the public assets.
 *
 * @param {import("nitropack").Nitro} nitro
 */
export async function writeArtifact(nitro) {
  const { backend = "portable", intl = {} } = nitro.options.fetchlet ?? {};
  const serverDir = nitro.options.output.serverDir;
  const entry = join(serverDir, "fetchlet.mjs");
  writeFileSync(
    join(serverDir, "environment.mjs"),
    `
    import { getBindings } from "@fetchlet/runtime/adapter";

    // Nitro's process.env reads globalThis.__env__, also while it
    // initializes the runtime config.
    globalThis.__env__ = Object.fromEntries(
      Object.entries(getBindings()).filter(([, value]) => typeof value === "string"),
    );
    `,
  );
  writeFileSync(
    entry,
    `
    import "./environment.mjs";
    import { createFetchHandler, getBindings, waitUntil } from "@fetchlet/runtime/adapter";
    import { handler } from ${JSON.stringify(modulePath(join(serverDir, "index.mjs")))};

    const fetchlet = { env: getBindings() };

    export const handle = createFetchHandler((request, context = {}) => {
      // Nitro copies _platform into the context of nested $fetch events.
      const platform = { clientAddress: context.clientAddress, fetchlet };
      return handler(request, { ...platform, _platform: platform, waitUntil });
    });
    `,
  );
  // fetchlet.json replaces Nitro's build information in the artifact.
  rmSync(join(nitro.options.output.dir, "nitro.json"), { force: true });
  await buildArtifact({
    entry,
    outDir: nitro.options.output.dir,
    framework: nitro.options.framework.name || "nitro",
    rendering: "buffered",
    backend,
    intl,
  });
}
