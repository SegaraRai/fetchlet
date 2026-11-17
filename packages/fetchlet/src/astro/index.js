import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { buildArtifact } from "../build/index.js";

/** @returns {import("astro").AstroIntegration} */
export default function fetchletAdapter({ out = "build", backend = "portable", intl = {} } = {}) {
  let output;
  let serverEntry;
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
