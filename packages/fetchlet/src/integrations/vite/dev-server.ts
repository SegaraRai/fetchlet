// Development serving for `fetchlet/vite`: the Vite dev server answers the
// module runner that the Rust host runs in its engine, and serves browser
// modules with HMR. fetchlet-http's `ViteDev` connects the two.

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

import type { EnvironmentModuleNode, Plugin, ResolvedConfig, ViteDevServer } from "vite";

import { buildArtifact, type BuildBackend, type IntlOptions } from "../../build/index.ts";

/** The path prefix of the endpoints this plugin adds to the dev server. */
const PREFIX = "/@fetchlet/";

// The package resolves itself, so the development artifact builds wherever
// the project is.
const devRunner = createRequire(import.meta.url).resolve("fetchlet/vite/dev-runner");

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface DevServerOptions {
  /** The server module, relative to the Vite root. */
  server: string;
  /** The engine the Rust host runs. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
}

/** Modules of the server environment that changed after a version. */
interface Change {
  version: number;
  ids: string[];
}

/**
 * The plugin that serves a fetchlet development host from `vite dev`:
 *
 * - `GET /@fetchlet/artifact/fetchlet.json` and `server.js`: an artifact
 *   whose server module runs Vite's module runner over the `FETCHLET_VITE`
 *   binding, with the engine's polyfills, built when first requested.
 * - `POST /@fetchlet/invoke`: the runner's calls, answered by the `ssr`
 *   environment as its own transport would.
 * - `POST /@fetchlet/updates`: the server modules changed since a version,
 *   with their importers, which the runner invalidates before each call.
 * - `GET /@fetchlet/client?entry=…`: a browser entry with Vite's HMR client.
 *
 * Every other request is Vite's. A change to a server module reloads open
 * pages, whose HTML the server renders.
 */
export function devServerPlugin({ server, backend, intl }: DevServerOptions): Plugin {
  let config: ResolvedConfig | undefined;
  let artifact: Promise<Record<string, string>> | undefined;
  const changes: Change[] = [];
  let version = 0;

  return {
    name: "fetchlet/vite:dev-server",
    apply: "serve",
    config(userConfig) {
      return {
        // Pages are the server module's; Vite serves modules and public files.
        appType: "custom",
        server: {
          // The Rust host proxies pages and modules but not WebSockets, so
          // the browser opens Vite's HMR socket on Vite's own port.
          strictPort: true,
          ...(userConfig.server?.ws === undefined
            ? { ws: { clientPort: userConfig.server?.port ?? 5173 } }
            : {}),
        },
      };
    },
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(devServer) {
      devServer.middlewares.use((request, response, next) => {
        const path = endpointPath(request.url ?? "", config?.base ?? "/");
        if (path === undefined) {
          next();
          return;
        }
        handle(devServer, path, request, response).catch((error: unknown) => {
          devServer.config.logger.error(`fetchlet/vite: ${String(error)}`);
          if (!response.headersSent) {
            response.statusCode = 500;
            response.end(String(error));
          }
        });
      });
    },
    hotUpdate({ modules, server: devServer }) {
      if (this.environment.name !== "ssr" || modules.length === 0) {
        return;
      }
      version += 1;
      changes.push({ version, ids: [...withImporters(modules)] });
      // The server renders the pages, so they show the change after a reload.
      devServer.environments.client?.hot.send({ type: "full-reload", path: "*" });
    },
  };

  async function handle(
    devServer: ViteDevServer,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const ssr = devServer.environments.ssr;
    if (!ssr) {
      throw new Error("the dev server has no ssr environment");
    }
    if (request.method === "GET" && path.startsWith("artifact/")) {
      artifact ??= buildDevArtifact(devServer).catch((error: unknown) => {
        artifact = undefined;
        throw error;
      });
      const files = await artifact;
      const file = files[path.slice("artifact/".length)];
      if (file === undefined) {
        response.statusCode = 404;
        response.end();
        return;
      }
      send(response, file, path.endsWith(".json") ? "application/json" : "text/javascript");
      return;
    }
    if (request.method === "GET" && path.startsWith("client?")) {
      const entry = new URLSearchParams(path.slice("client?".length)).get("entry") ?? "";
      const base = devServer.config.base;
      send(
        response,
        `import ${JSON.stringify(base + "@vite/client")};\nimport ${JSON.stringify(base + entry.replace(/^\.?\//, ""))};\n`,
        "text/javascript",
      );
      return;
    }
    if (request.method === "POST" && path === "invoke") {
      const payload = JSON.parse(await readBody(request));
      const result = await ssr.hot.handleInvoke(payload);
      send(response, JSON.stringify(result), "application/json");
      return;
    }
    if (request.method === "POST" && path === "updates") {
      const { since } = JSON.parse(await readBody(request)) as { since: number | null };
      const invalidated = new Set<string>();
      if (since !== null) {
        for (const change of changes) {
          if (change.version > since) {
            change.ids.forEach((id) => invalidated.add(id));
          }
        }
      }
      send(
        response,
        JSON.stringify({ version, invalidated: [...invalidated] }),
        "application/json",
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  }

  /** The development artifact: the runner bootstrap built for the engine. */
  async function buildDevArtifact(devServer: ViteDevServer): Promise<Record<string, string>> {
    const root = devServer.config.root;
    const entry = "/" + modulePath(relative(root, resolve(root, server)));
    const names = await exportedNames(devServer, entry);
    const outDir = join(devServer.config.cacheDir, "fetchlet-dev");
    await buildArtifact({
      entry: {
        source: [
          `import { devServer } from ${JSON.stringify(modulePath(devRunner))};`,
          `const dev = devServer(${JSON.stringify(entry)});`,
          "export const handle = dev.handle;",
          ...names.map(
            (name) =>
              `export const ${name} = (...args) => dev.call(${JSON.stringify(name)}, args);`,
          ),
        ].join("\n"),
        resolveDir: root,
      },
      outDir,
      framework: "vite",
      rendering: "streaming",
      ...(backend ? { backend } : {}),
      ...(intl ? { intl } : {}),
    });
    return {
      "fetchlet.json": readFileSync(join(outDir, "fetchlet.json"), "utf8"),
      "server.js": readFileSync(join(outDir, "server.js"), "utf8"),
    };
  }
}

/**
 * The named function exports of the server module, read from Vite's server
 * transform, which declares each with `__vite_ssr_exportName__`. A function
 * exported later needs a dev server restart to be callable from Rust.
 */
async function exportedNames(devServer: ViteDevServer, entry: string): Promise<string[]> {
  const result = await devServer.environments.ssr!.transformRequest(entry);
  const names = new Set<string>();
  for (const match of (result?.code ?? "").matchAll(/__vite_ssr_exportName__\("([^"]+)"/g)) {
    const name = match[1]!;
    if (name !== "default" && name !== "handle" && /^[A-Za-z_$][\w$]*$/.test(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** The ids of `modules` and every module that imports them. */
function withImporters(modules: readonly EnvironmentModuleNode[]): Set<string> {
  const ids = new Set<string>();
  const pending = [...modules];
  const seen = new Set<EnvironmentModuleNode>();
  while (pending.length) {
    const node = pending.pop()!;
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    if (node.id) {
      ids.add(node.id);
    }
    pending.push(...node.importers);
  }
  return ids;
}

/** The endpoint path after `/@fetchlet/`, or undefined for other requests. */
function endpointPath(url: string, base: string): string | undefined {
  const prefix = base.replace(/\/$/, "") + PREFIX;
  if (url.startsWith(prefix)) {
    return url.slice(prefix.length);
  }
  if (url.startsWith(PREFIX)) {
    return url.slice(PREFIX.length);
  }
  return undefined;
}

function send(response: ServerResponse, body: string, contentType: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
