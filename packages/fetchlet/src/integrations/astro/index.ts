import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";

import { IMMUTABLE } from "../../build/asset-entries.ts";
import { frameworkAssets, type AssetsOption } from "../../build/asset-option.ts";
import { buildArtifact, type BuildBackend, type IntlOptions } from "../../build/index.ts";

export interface FetchletAstroOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses Astro's: hashed files under `build.assets` are
   * cached for a year, and pages follow `trailingSlash` and `build.format`;
   * settings adjust those defaults and add entries, and a function returns every entry. See docs/asset-archive.md.
   */
  assets?: AssetsOption;
  /** The artifact directory. Defaults to "build". */
  out?: string;
  /** The engine the artifact targets. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl. */
  intl?: IntlOptions;
}

/** The Astro adapter that builds the server output into a fetchlet artifact. */
export default function fetchletAdapter({
  out = "build",
  backend = "portable",
  intl = {},
  assets = false,
}: FetchletAstroOptions = {}): AstroIntegration {
  let output: string;
  let serverEntry: string;
  let archive: AssetsOption | undefined;
  return {
    name: "fetchlet/astro",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        output = resolve(fileURLToPath(config.root), out);
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
          requirements: ["Intl.DateTimeFormat"],
          backend,
          intl,
          ...(archive ? { assets: archive } : {}),
        });
      },
    },
  };
}
