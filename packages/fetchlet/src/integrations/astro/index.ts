import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";
import type { Plugin } from "vite";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import { frameworkAssets, type AssetsOption } from "../../build/asset-option.ts";
import { buildArtifact, type BuildBackend, type IntlOptions } from "../../build/index.ts";
import { devServerPlugin } from "../vite/dev-server.ts";

export interface FetchletAstroOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses Astro's: hashed files under `build.assets` are
   * cached for a year, and pages follow `trailingSlash` and `build.format`;
   * settings adjust those defaults and add entries, and a function returns every entry. See https://fetchlet.roundtrip.dev/docs/reference/asset-archive.
   */
  assets?: AssetsOption;
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
   * `astro dev` serves a Rust host that uses fetchlet-http's `ViteDev`
   * instead of rendering in Node: the host runs Astro's development app on
   * its engine through Vite's module runner. Defaults to false.
   */
  devServer?: boolean;
}

/** The module the engine's runner imports in development. */
const DEV_ENTRY = "virtual:fetchlet/astro-dev-entry";

/**
 * Astro's development app over the `ssr` environment, with the request
 * context of `fetchlet/astro/server`. `astro/app/entrypoint` resolves to
 * Astro's app for non-runnable environments under `astro dev`.
 */
const DEV_ENTRY_SOURCE = `
import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";

const app = createApp({
  streaming: true,
});

let bindings = {};
setGetEnv((key) => (typeof bindings[key] === "string" ? bindings[key] : undefined));

export default {
  fetch(request, env, ctx) {
    bindings = env;
    return app.render(request, {
      clientAddress: ctx.clientAddress,
      locals: {
        env,
        waitUntil: ctx.waitUntil,
      },
      addCookieHeader: true,
    });
  },
};
`;

/** The Vite plugins of development serving. */
function devServerPlugins(
  backend: BuildBackend,
  intl: IntlOptions,
  requirements: string[],
): Plugin[] {
  return [
    devServerPlugin({
      name: "fetchlet/astro:dev-server",
      entry: DEV_ENTRY,
      // Astro renders in Node whenever the ssr environment is runnable.
      runnable: false,
      framework: "astro",
      rendering: "streaming",
      requirements,
      // Astro's development app imports these on the first request; naming
      // them up front spares the reloads that discovering them one by one
      // causes in the middle of that request.
      include: [
        "astro/app/entrypoint/dev",
        "astro/app/fetch/default-handler",
        "astro/app/manifest",
        "astro/compiler-runtime",
        "astro/logger/json",
        "astro/virtual-modules/transitions.js",
      ],
      backend,
      intl,
    }),
    {
      name: "fetchlet/astro:dev-entry",
      apply: "serve",
      resolveId(source) {
        return source === DEV_ENTRY ? "\0" + DEV_ENTRY : undefined;
      },
      load(id) {
        return id === "\0" + DEV_ENTRY ? DEV_ENTRY_SOURCE : undefined;
      },
    },
  ];
}

/** The Astro adapter that builds the server output into a fetchlet artifact. */
export default function fetchletAdapter({
  out = "build",
  backend = "portable",
  intl = {},
  requirements = [],
  assets = false,
  devServer = false,
}: FetchletAstroOptions = {}): AstroIntegration {
  // Astro formats dates with Intl.DateTimeFormat.
  const required = ["Intl.DateTimeFormat", ...requirements];
  let output: string;
  let serverEntry: string;
  let archive: AssetsOption | undefined;
  return {
    name: "fetchlet/astro",
    hooks: {
      "astro:config:setup": ({ command, config, updateConfig }) => {
        output = resolve(fileURLToPath(config.root), out);
        if (command === "dev" && devServer) {
          updateConfig({
            vite: {
              plugins: devServerPlugins(backend, intl, required),
            },
          });
        }
        updateConfig({
          outDir: pathToFileURL(output + "/"),
          build: {
            client: pathToFileURL(join(output, "client") + "/"),
            server: new URL("./fetchlet/server/", config.cacheDir),
            serverEntry: "entry.mjs",
          },
        });
      },
      "astro:config:done": ({ config, setAdapter }) => {
        serverEntry = fileURLToPath(new URL(config.build.serverEntry, config.build.server));
        if (assets) {
          archive = frameworkAssets(assets, {
            cache: [{ prefix: `/${config.build.assets}/`, cacheControl: IMMUTABLE }],
            routes: {
              trailingSlash: config.trailingSlash,
              htmlExtension: config.build.format === "directory" ? "keep" : "strip",
            },
          });
        }
        setAdapter({
          name: "fetchlet/astro",
          entrypointResolution: "auto",
          serverEntrypoint: "fetchlet/astro/server",
          supportedAstroFeatures: {
            serverOutput: "stable",
            staticOutput: "unsupported",
            sharpImageService: "unsupported",
            envGetSecret: "stable",
          },
        });
      },
      "astro:build:done": async () => {
        await buildArtifact({
          entry: serverEntry,
          outDir: output,
          framework: "astro",
          rendering: "streaming",
          requirements: required,
          backend,
          intl,
          ...(archive ? { assets: archive } : {}),
        });
      },
    },
  };
}
