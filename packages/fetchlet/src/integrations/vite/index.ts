import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Plugin, ResolvedConfig } from "vite";

import { runtimeConditions } from "../../build/conditions.ts";
import { exportedHandlerSource } from "../../build/exported-handler.ts";
import { devServerPlugin } from "./dev-server.ts";
import { serverEnvironmentPlugin, type ViteArtifactOptions } from "./server-environment.ts";

export interface FetchletViteOptions extends ViteArtifactOptions {
  /**
   * The server module, in the Workers module shape: its default export's
   * `fetch(request, env, ctx)` handles requests, and its named exports stay
   * callable from Rust with `App::call`. Defaults to "src/server.ts".
   */
  server?: string;
  /**
   * Browser entries, built into `<outDir>/client`. The server reads their
   * built URLs from `virtual:fetchlet/client-assets`. Without it, the client
   * build uses `index.html` when the project has one and is skipped otherwise.
   */
  client?: string | string[];
}

/** The module through which the server reads the built URLs of the browser entries. */
const clientAssetsId = "virtual:fetchlet/client-assets";

interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  css?: string[];
  imports?: string[];
}

/**
 * Vite plugins that build a server module in the Workers module shape into
 * a fetchlet artifact, with its browser entries as the client assets:
 * server.js and fetchlet.json next to `client/`. `vite build` builds the
 * client, then the server.
 */
export default function fetchlet({
  server = "src/server.ts",
  client,
  ...options
}: FetchletViteOptions = {}): Plugin[] {
  const clientEntries = typeof client === "string" ? [client] : client;
  let config: ResolvedConfig | undefined;
  const app: Plugin = {
    name: "fetchlet/vite:app",
    config(userConfig) {
      const root = resolve(userConfig.root ?? process.cwd());
      const hasClient = clientEntries !== undefined || existsSync(resolve(root, "index.html"));
      return {
        builder: {
          async buildApp(builder) {
            if (hasClient) {
              await builder.build(builder.environments.client!);
            }
            await builder.build(builder.environments.ssr!);
          },
        },
        environments: {
          client: {
            build: {
              manifest: true,
              ...(clientEntries ? { rolldownOptions: { input: clientEntries } } : {}),
            },
          },
          ssr: {
            build: {
              rolldownOptions: {
                input: {
                  server,
                },
              },
            },
          },
        },
      };
    },
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(id) {
      if (id === clientAssetsId) {
        return "\0" + clientAssetsId;
      }
    },
    load(id) {
      if (id !== "\0" + clientAssetsId) {
        return;
      }
      if (this.environment.mode === "dev") {
        // Vite serves the sources themselves during development, behind an
        // entry that also loads its HMR client; styles come with the modules.
        const base = config?.base ?? "/";
        return `export default ${JSON.stringify(
          Object.fromEntries(
            (clientEntries ?? []).map((entry) => {
              const source = entry.replace(/^\.\//, "");
              const script = `${base}@fetchlet/client?entry=${encodeURIComponent(source)}`;
              return [source, { script, styles: [] }];
            }),
          ),
        )};`;
      }
      const manifestFile = config && clientManifestFile(config);
      if (manifestFile) {
        // Under `vite build --watch`, a client rebuild rewrites the manifest
        // and so rebuilds the server with the new URLs.
        this.addWatchFile(manifestFile);
      }
      const clientAssets = manifestFile ? readClientAssets(config!, manifestFile) : {};
      return `export default ${JSON.stringify(clientAssets)};`;
    },
  };
  return [
    app,
    serverEnvironmentPlugin(
      {
        name: "fetchlet/vite",
        framework: "vite",
        rendering: "streaming",
        isServerEntry: (chunk) => chunk.name === "server",
        serverEnvironment: {
          resolve: {
            // fetchlet's builds of dependencies, bundled for the engine.
            conditions: runtimeConditions(),
          },
        },
        entrySource: exportedHandlerSource,
      },
      options,
    ),
    devServerPlugin({
      name: "fetchlet/vite:dev-server",
      entry: server,
      functions: true,
      customApp: true,
      framework: "vite",
      rendering: "streaming",
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.intl ? { intl: options.intl } : {}),
      ...(options.requirements ? { requirements: options.requirements } : {}),
    }),
  ];
}

/** The manifest the client build writes, when there is a client environment. */
function clientManifestFile(config: ResolvedConfig): string | undefined {
  const clientConfig = config.environments.client;
  if (!clientConfig) {
    return undefined;
  }
  return resolve(
    config.root,
    clientConfig.build.outDir,
    typeof clientConfig.build.manifest === "string"
      ? clientConfig.build.manifest
      : ".vite/manifest.json",
  );
}

/**
 * The built URLs of the client build's entries, keyed by their source path
 * relative to the root, from the manifest Vite wrote. The asset archive
 * leaves `.vite/` out, so the manifest is not served.
 */
function readClientAssets(
  config: ResolvedConfig,
  manifestFile: string,
): Record<string, { script: string; styles: string[] }> {
  if (!existsSync(manifestFile)) {
    return {};
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, ManifestChunk>;
  const base = config.base.endsWith("/") ? config.base : config.base + "/";
  // Styles of an entry include those of the chunks it imports statically.
  const styles = (key: string, seen = new Set<string>()): string[] => {
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    const chunk = manifest[key];
    return [
      ...(chunk?.css ?? []),
      ...(chunk?.imports ?? []).flatMap((imported) => styles(imported, seen)),
    ];
  };
  return Object.fromEntries(
    Object.entries(manifest)
      .filter(([, chunk]) => chunk.isEntry)
      .map(([key, chunk]) => [
        key,
        {
          script: base + chunk.file,
          styles: [...new Set(styles(key))].map((file) => base + file),
        },
      ]),
  );
}
