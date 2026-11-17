import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

import type { AstroIntegration } from "astro";

import { buildArtifact, type BuildBackend, type IntlOptions } from "../build/index.ts";
import { frameworkAssets, IMMUTABLE, type AssetArchiveSettings } from "../build/asset-archive.ts";

export interface FetchletAstroOptions {
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` uses Astro's: hashed files under `build.assets` are
   * cached for a year, and pages follow `trailingSlash` and `build.format`; an object adds
   * `respond`, which runs after them, and `routes`. See docs/asset-archive.md.
   */
  assets?: boolean | AssetArchiveSettings;
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
  let archive: AssetArchiveSettings | undefined;
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
          rendering: "buffered",
          requirements: ["Intl.DateTimeFormat"],
          backend,
          intl,
          ...(archive ? { assets: archive } : {}),
        });
      },
    },
  };
}
