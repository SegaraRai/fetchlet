import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

import type { AstroIntegration } from "astro";

import { buildArtifact, type BuildBackend, type IntlOptions } from "../build/index.ts";

export interface FetchletAstroOptions {
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
}: FetchletAstroOptions = {}): AstroIntegration {
  let output: string;
  let serverEntry: string;
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
        });
      },
    },
  };
}
