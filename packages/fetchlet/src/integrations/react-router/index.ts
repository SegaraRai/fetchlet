import { join } from "node:path";

import type { Preset } from "@react-router/dev/config";
import type { Plugin } from "vite";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import { frameworkAssets, type AssetsOption } from "../../build/asset-option.ts";
import { buildArtifact, type BuildBackend, type IntlOptions } from "../../build/index.ts";
import { devServerPlugin } from "../vite/dev-server.ts";

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface FetchletPresetOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses React Router's: hashed files under `assets/` are
   * cached for a year; settings adjust those defaults and add entries, and
   * a function returns every entry. See docs/asset-archive.md.
   */
  assets?: AssetsOption;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
  /**
   * APIs the application needs beyond the Web API profile, as in
   * fetchlet/build: Intl APIs such as `Intl.DateTimeFormat`, and globals over
   * host Web APIs such as `crypto.subtle`. Recorded in fetchlet.json, where
   * the Rust host checks them before the server runs.
   */
  requirements?: string[];
}

interface ArtifactOptions {
  reactRouterConfig: {
    buildDirectory: string;
    serverBuildFile: string;
  };
  backend: BuildBackend;
  intl: IntlOptions;
  requirements: string[];
  assets: AssetsOption;
}

/**
 * A React Router preset that bundles the server build into a fetchlet
 * artifact: server.js and fetchlet.json next to build/client.
 */
export function fetchletPreset({
  backend = "portable",
  intl = {},
  requirements = [],
  assets = false,
}: FetchletPresetOptions = {}): Preset {
  return {
    name: "fetchlet/react-router",
    reactRouterConfig: () => ({
      ssr: true,
      serverModuleFormat: "esm",
      buildEnd: ({ reactRouterConfig }) =>
        writeArtifact({
          reactRouterConfig,
          backend,
          intl,
          requirements,
          assets,
        }),
    }),
    reactRouterConfigResolved({ reactRouterConfig }) {
      if (reactRouterConfig.serverBundles) {
        throw new Error("fetchlet/react-router builds one server bundle");
      }
      if (!reactRouterConfig.ssr) {
        throw new Error("fetchlet/react-router requires ssr: true");
      }
    },
  };
}

async function writeArtifact({
  reactRouterConfig,
  backend,
  intl,
  requirements,
  assets,
}: ArtifactOptions): Promise<void> {
  const { buildDirectory, serverBuildFile } = reactRouterConfig;
  const serverDirectory = join(buildDirectory, "server");
  const entrySource = `
    import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
    import { createRequestHandler, RouterContextProvider } from "react-router";
    import { fetchletContext } from "fetchlet/react-router/context";
    import * as build from ${JSON.stringify("./" + modulePath(serverBuildFile))};

    const handler = createRequestHandler(build, "production");
    const env = getBindings();

    export const handle = createFetchHandler((request, context = {}) => {
      const provider = new RouterContextProvider();
      provider.set(fetchletContext, {
        clientAddress: context.clientAddress,
        env,
        waitUntil,
      });
      return handler(request, provider);
    });
    `;
  await buildArtifact({
    entry: {
      source: entrySource,
      resolveDir: serverDirectory,
    },
    outDir: buildDirectory,
    framework: "react-router",
    rendering: "streaming",
    backend,
    intl,
    requirements,
    ...(assets
      ? {
          assets: frameworkAssets(assets, {
            cache: [{ prefix: "/assets/", cacheControl: IMMUTABLE }],
          }),
        }
      : {}),
  });
}

export interface FetchletDevServerOptions {
  /** The engine the Rust host runs. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
  /**
   * APIs the application needs beyond the Web API profile, as in
   * fetchlet/build: Intl APIs such as `Intl.DateTimeFormat`, and globals over
   * host Web APIs such as `crypto.subtle`. Recorded in fetchlet.json, where
   * the Rust host checks them before the server runs.
   */
  requirements?: string[];
}

/** The development entry: React Router's server build with the preset's request context. */
const DEV_ENTRY = "virtual:fetchlet/react-router-dev-entry";

const devEntrySource = `
  import { createRequestHandler, RouterContextProvider } from "react-router";
  import { fetchletContext } from "fetchlet/react-router/context";
  import * as build from "virtual:react-router/server-build";

  const handler = createRequestHandler(build, "development");

  export default {
    fetch(request, env, ctx) {
      const provider = new RouterContextProvider();
      provider.set(fetchletContext, {
        clientAddress: ctx.clientAddress,
        env,
        waitUntil: ctx.waitUntil,
      });
      return handler(request, provider);
    },
  };
`;

/**
 * A Vite plugin, beside `reactRouter()`, that serves a fetchlet Rust host
 * from `vite dev`: the host runs React Router's server build on its engine
 * with the request context of `fetchletPreset`'s artifact. React Router
 * renders in Node whenever its `ssr` environment is runnable, so this
 * plugin makes it a plain environment that the engine's runner fetches from.
 */
export function fetchletDevServer(options: FetchletDevServerOptions = {}): Plugin[] {
  return [
    devServerPlugin({
      name: "fetchlet/react-router:dev-server",
      entry: DEV_ENTRY,
      runnable: false,
      framework: "react-router",
      rendering: "streaming",
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.intl ? { intl: options.intl } : {}),
      ...(options.requirements ? { requirements: options.requirements } : {}),
    }),
    {
      name: "fetchlet/react-router:dev-entry",
      apply: "serve",
      resolveId(source) {
        return source === DEV_ENTRY ? "\0" + DEV_ENTRY : undefined;
      },
      load(id) {
        return id === "\0" + DEV_ENTRY ? devEntrySource : undefined;
      },
    },
  ];
}
