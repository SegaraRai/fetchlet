import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Adapter } from "@sveltejs/kit";
import type { Plugin } from "rolldown";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import { frameworkAssets, type AssetsOption } from "../../build/asset-option.ts";
import { buildArtifact, type BuildBackend, type IntlOptions } from "../../build/index.ts";

export interface FetchletSvelteKitOptions {
  /** The artifact directory. Defaults to "build". */
  out?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl. */
  intl?: IntlOptions;
  /**
   * APIs the application needs beyond the Web API profile, as in
   * fetchlet/build: Intl APIs such as `Intl.DateTimeFormat`, and globals over
   * host Web APIs such as `crypto.subtle`. Recorded in fetchlet.json, where
   * the Rust host checks them before the server runs.
   */
  requirements?: string[];
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
   * "never"`. Settings adjust those defaults and add entries; their
   * `routes` replace SvelteKit's. A function returns every entry. See
   * docs/asset-archive.md.
   */
  assets?: AssetsOption;
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
  requirements = [],
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
      mkdirSync(output, { recursive: true });
      mkdirSync(temporary, { recursive: true });

      builder.writeServer(server);
      builder.generateServerInstance(join(temporary, "server-instance.js"), {
        serverDirectory: server,
      });
      builder.writeClient(join(output, "client"));
      builder.writePrerendered(join(output, "client"));

      const entrySource = `
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
      `;

      await buildArtifact({
        entry: {
          source: entrySource,
          resolveDir: temporary,
        },
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
        requirements,
        ...(assets
          ? {
              assets: frameworkAssets(assets, {
                cache: [
                  {
                    prefix: `/${builder.config.appDir}/immutable/`,
                    cacheControl: IMMUTABLE,
                  },
                ],
                routes: {
                  trailingSlash: "never",
                  htmlExtension: "strip",
                },
              }),
            }
          : {}),
      });
    },
  };
}
