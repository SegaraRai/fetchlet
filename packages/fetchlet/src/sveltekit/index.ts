import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type { Adapter } from "@sveltejs/kit";
import type { Plugin } from "rolldown";

import {
  buildArtifact,
  type AssetArchiveSettings,
  type BuildBackend,
  type IntlOptions,
} from "../build/index.ts";
import { frameworkAssets, IMMUTABLE } from "../build/asset-archive.ts";

export interface FetchletSvelteKitOptions {
  /** The artifact directory. Defaults to "build". */
  out?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl. */
  intl?: IntlOptions;
  /**
   * "async" supports Svelte's asynchronous server rendering and remote
   * functions: `getRequestEvent()` keeps the current request across awaits
   * within one invocation. Defaults to "synchronous".
   */
  rendering?: "synchronous" | "async";
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses SvelteKit's conventions: hashed files under
   * `_app/immutable/` are cached for a year, and prerendered pages are served
   * without `.html` and without a trailing slash, the default `trailingSlash:
   * "never"`. An object sets `respond` and `routes` instead; its `respond`
   * runs after the immutable caching is applied, and its `routes` replace
   * SvelteKit's.
   */
  assets?: boolean | AssetArchiveSettings;
}

function synchronousRendering(): Plugin {
  const virtualId = "\0fetchlet:async-hooks";
  return {
    name: "fetchlet-synchronous-rendering",
    resolveId(id) {
      if (id === "node:async_hooks") {
        return virtualId;
      }
    },
    load(id) {
      if (id === virtualId) {
        return `export class AsyncLocalStorage {
          constructor() {
            throw new Error("This fetchlet profile uses synchronous Svelte rendering");
          }
        }`;
      }
    },
  };
}

/** The SvelteKit adapter that builds the server into a fetchlet artifact. */
export default function fetchletAdapter({
  out = "build",
  backend = "portable",
  intl = {},
  rendering = "synchronous",
  assets = false,
}: FetchletSvelteKitOptions = {}): Adapter {
  if (rendering !== "synchronous" && rendering !== "async") {
    throw new Error(`Unknown rendering profile ${JSON.stringify(rendering)}`);
  }
  return {
    name: "fetchlet/sveltekit",
    async adapt(builder) {
      const output = resolve(out);
      const temporary = resolve(builder.getBuildDirectory("fetchlet"));
      const server = join(temporary, "server");
      const entry = join(temporary, "entry.ts");
      mkdirSync(output, { recursive: true });
      mkdirSync(temporary, { recursive: true });

      builder.writeServer(server);
      builder.generateServerInstance(join(temporary, "server-instance.js"), {
        serverDirectory: server,
      });
      builder.writeClient(join(output, "client"));
      builder.writePrerendered(join(output, "client"));

      writeFileSync(
        entry,
        `
        import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
        import { server } from "./server-instance.js";

        const bindings = getBindings();
        const env = Object.fromEntries(
          Object.entries(bindings).filter(([, value]) => typeof value === "string"),
        );
        let initialization;

        export const handle = createFetchHandler(async (request, context) => {
          initialization ??= server.init({ env });
          await initialization;
          return server.respond(request, {
            getClientAddress: () => context.clientAddress,
            platform: {
              env: bindings,
              context: {
                waitUntil,
              },
            },
          });
        });
      `,
      );

      await buildArtifact({
        entry,
        outDir: output,
        // An App runs one invocation at a time, so a store that lasts until
        // the request's promise settles is the request's own.
        ...(rendering === "async"
          ? { asyncContext: "serialized" as const }
          : { plugins: [synchronousRendering()] }),
        framework: "sveltekit",
        rendering,
        backend,
        intl,
        ...(assets
          ? {
              assets: frameworkAssets(assets, {
                cache: [
                  { prefix: `/${builder.config.appDir}/immutable/`, cacheControl: IMMUTABLE },
                ],
                routes: { trailingSlash: "never", htmlExtension: "strip" },
              }),
            }
          : {}),
      });
    },
  };
}
