// Development serving for fetchlet's Vite integrations: the Vite dev server
// answers the module runner that the Rust host runs in its engine, and
// serves browser modules with HMR. fetchlet-http's `ViteDev` connects the two.

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

import {
  createServerHotChannel,
  DevEnvironment,
  type EnvironmentModuleNode,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from "vite";

import { buildArtifact, type BuildBackend, type IntlOptions } from "../../build/index.ts";
import {
  type AsyncContextMode,
  implementedNodeBuiltins,
  nodeGlobals,
} from "../../build/node-builtins.ts";

/** The path prefix of the endpoints this plugin adds to the dev server. */
const PREFIX = "/@fetchlet/";

// The package resolves itself, so the development artifact builds wherever
// the project is.
const devRunner = createRequire(import.meta.url).resolve("fetchlet/vite/dev-runner");

const modulePath = (file: string): string => file.replaceAll("\\", "/");

export interface DevServerOptions {
  /** The plugin name, such as `fetchlet/vite:dev-server`. */
  name: string;
  /**
   * The module the runner imports: a file relative to the Vite root, or a
   * framework's virtual module id.
   */
  entry: string;
  /** The server environment. Defaults to "ssr". */
  environment?: string;
  /**
   * JavaScript source of a `DevDispatch` from `fetchlet/vite/dev-runner`,
   * which calls the entry for a request. Defaults to the Workers module
   * shape.
   */
  dispatch?: string;
  /**
   * Dependencies to prebundle up front, such as CommonJS modules the
   * integration resolves to by path.
   */
  include?: string[];
  /** Make the entry's named function exports callable from Rust. */
  functions?: boolean;
  /**
   * `false` makes the server environment a plain, non-runnable
   * `DevEnvironment`, for frameworks that render in Node whenever it is
   * runnable rather than when it lacks `dispatchFetch`. Defaults to true.
   */
  runnable?: boolean;
  /** Pages come from the entry, so Vite serves no HTML of its own. */
  customApp?: boolean;
  /** Recorded in fetchlet.json. */
  framework: string;
  /** Recorded in fetchlet.json. */
  rendering: string;
  /** How node:async_hooks is provided, as in fetchlet/build. */
  asyncContext?: AsyncContextMode;
  /** The engine the Rust host runs. */
  backend?: BuildBackend;
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: IntlOptions;
}

/** Modules of the server environment that changed after a version. */
interface Change {
  version: number;
  ids: string[];
  /** Vite reloaded the whole environment. */
  reset?: boolean;
}

/**
 * The plugin that serves a fetchlet development host from `vite dev`:
 *
 * - `GET /@fetchlet/artifact/fetchlet.json` and `server.js`: an artifact
 *   whose server module runs Vite's module runner over the `FETCHLET_VITE`
 *   binding, with the engine's polyfills and Node built-ins, built when first
 *   requested.
 * - `POST /@fetchlet/invoke`: the runner's calls, answered by the server
 *   environment as its own transport would.
 * - `POST /@fetchlet/updates`: the server modules changed since a version,
 *   with their importers, which the runner invalidates before each call.
 * - `GET /@fetchlet/client?entry=…`: a browser entry with Vite's HMR client.
 *
 * The server environment is marked fetchable, so a framework's own
 * development middleware leaves requests to the Rust host. Every other
 * request is Vite's. A change to a server module that no browser module
 * shares reloads open pages, whose HTML the server renders.
 */
export function devServerPlugin(options: DevServerOptions): Plugin {
  const environmentName = options.environment ?? "ssr";
  let config: ResolvedConfig | undefined;
  let artifact: Promise<Record<string, string>> | undefined;
  const changes: Change[] = [];
  let version = 0;

  return {
    name: options.name,
    apply: "serve",
    config(userConfig) {
      return {
        ...(options.customApp ? { appType: "custom" as const } : {}),
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
    configEnvironment(name, environmentConfig) {
      if (name !== environmentName) {
        return;
      }
      // Integrations resolve the server for production builds; development
      // modules, such as React's JSX dev runtime, need the development builds.
      const conditions = environmentConfig.resolve?.conditions;
      if (conditions) {
        environmentConfig.resolve!.conditions = conditions.map((condition) =>
          condition === "production" ? "development" : condition,
        );
      }
      // The engine evaluates ES modules only, so CommonJS dependencies are
      // prebundled into ES modules, as Vite does for the browser.
      return {
        // The engine loads only the modules Vite transforms.
        resolve: {
          noExternal: true,
        },
        optimizeDeps: {
          noDiscovery: false,
          ...(options.include ? { include: options.include } : {}),
        },
        ...(options.runnable === false
          ? {
              dev: {
                // The engine's runner reaches the environment through
                // `handleInvoke`, which a server hot channel provides.
                createEnvironment: (name, resolvedConfig) =>
                  new DevEnvironment(name, resolvedConfig, {
                    hot: true,
                    transport: createServerHotChannel(),
                  }),
              },
            }
          : {}),
      };
    },
    configResolved(resolved) {
      config = resolved;
      // Framework packages whose imports the framework's plugins rewrite stay
      // out of prebundling, as frameworks arrange for the browser.
      const server = resolved.environments[environmentName]?.optimizeDeps;
      const client = resolved.environments.client?.optimizeDeps;
      if (server && client) {
        server.exclude = [...new Set([...(server.exclude ?? []), ...(client.exclude ?? [])])];
        // Their CommonJS dependencies, which the framework lists as nested
        // includes such as `@scope/framework > cookie`, are prebundled.
        server.include = [...new Set([...(server.include ?? []), ...(client.include ?? [])])];
      }
    },
    configureServer(devServer) {
      const environment = devServer.environments[environmentName];
      if (environment) {
        // Vite tells the environment's runners to start over, as after it
        // optimized dependencies again; the engine's runner learns it from
        // the next update.
        const hot = environment.hot;
        const send = hot.send.bind(hot);
        hot.send = ((...args: Parameters<typeof send>) => {
          const [payload] = args;
          if ((payload as { type?: string } | undefined)?.type === "full-reload") {
            version += 1;
            changes.push({
              version,
              ids: [],
              reset: true,
            });
          }
          send(...args);
        }) as typeof hot.send;
      }
      if (environment && !("dispatchFetch" in environment)) {
        // Frameworks that find a fetchable server environment leave its
        // requests to whoever dispatches them: here, the Rust host.
        Object.defineProperty(environment, "dispatchFetch", {
          configurable: true,
          value: () => {
            throw new Error(`${options.name}: the fetchlet host dispatches requests`);
          },
        });
      }
      devServer.middlewares.use((request, response, next) => {
        const path = endpointPath(request.url ?? "", config?.base ?? "/");
        if (path === undefined) {
          next();
          return;
        }
        handle(devServer, path, request, response).catch((error: unknown) => {
          devServer.config.logger.error(`${options.name}: ${String(error)}`);
          if (!response.headersSent) {
            response.statusCode = 500;
            response.end(String(error));
          }
        });
      });
    },
    hotUpdate({ file, modules, server: devServer }) {
      if (this.environment.name !== environmentName || modules.length === 0) {
        return;
      }
      version += 1;
      changes.push({ version, ids: [...withImporters(modules)] });
      // A module the browser also loads is replaced there; otherwise only a
      // reload shows what the server renders now.
      const client = devServer.environments.client;
      if (client && !client.moduleGraph.getModulesByFile(file)?.size) {
        client.hot.send({
          type: "full-reload",
          path: "*",
        });
      }
    },
  };

  async function handle(
    devServer: ViteDevServer,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const environment = devServer.environments[environmentName];
    if (!environment) {
      throw new Error(`the dev server has no ${environmentName} environment`);
    }
    if (request.method === "GET" && path.startsWith("artifact/")) {
      artifact ??= buildDevArtifact(devServer, environment).catch((error: unknown) => {
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
      const result = await environment.hot.handleInvoke(payload);
      send(response, JSON.stringify(result), "application/json");
      return;
    }
    if (request.method === "POST" && path === "updates") {
      const { since } = JSON.parse(await readBody(request)) as { since: number | null };
      const invalidated = new Set<string>();
      let reset = false;
      if (since !== null) {
        for (const change of changes) {
          if (change.version > since) {
            change.ids.forEach((id) => invalidated.add(id));
            reset ||= change.reset === true;
          }
        }
      }
      send(
        response,
        JSON.stringify({
          version,
          invalidated: [...invalidated],
          reset,
        }),
        "application/json",
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  }

  /** The development artifact: the runner bootstrap built for the engine. */
  async function buildDevArtifact(
    devServer: ViteDevServer,
    environment: DevEnvironment,
  ): Promise<Record<string, string>> {
    const root = devServer.config.root;
    const entry = /^[\w-]+:|^[#\0]/.test(options.entry)
      ? options.entry
      : "/" + modulePath(relative(root, resolve(root, options.entry)));
    const names = options.functions ? await exportedNames(environment, entry) : [];
    const builtins = nodeBuiltinNames(options.asyncContext);
    const builtinTable = builtins
      .map((name, index) => `${JSON.stringify(name)}: builtin${index}`)
      .join(", ");
    const globalTable = Object.entries(nodeGlobals)
      .map(([name, source]) => {
        const [module, member] = typeof source === "string" ? [source, "default"] : source;
        const index = builtins.indexOf(module.slice("node:".length));
        return index < 0 ? undefined : `${name}: builtin${index}[${JSON.stringify(member)}]`;
      })
      .filter((entry) => entry !== undefined)
      .join(", ");
    const outDir = join(devServer.config.cacheDir, "fetchlet-dev");
    await buildArtifact({
      entry: {
        source: [
          ...builtins.map((name, index) => `import * as builtin${index} from "node:${name}";`),
          // Dependencies choose their development builds, as under `vite dev` in Node.
          `import process from "node:process";`,
          `import { devServer } from ${JSON.stringify(modulePath(devRunner))};`,
          `process.env.NODE_ENV = "development";`,
          `const dev = devServer(${JSON.stringify(entry)}, {`,
          `  builtins: { ${builtinTable} },`,
          `  globals: { ${globalTable} },`,
          ...(options.dispatch ? [`  dispatch: ${options.dispatch},`] : []),
          "});",
          "export const handle = dev.handle;",
          ...names.map(
            (name) =>
              `export const ${name} = (...args) => dev.call(${JSON.stringify(name)}, args);`,
          ),
        ].join("\n"),
        resolveDir: root,
      },
      outDir,
      framework: options.framework,
      rendering: options.rendering,
      ...(options.asyncContext ? { asyncContext: options.asyncContext } : {}),
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.intl ? { intl: options.intl } : {}),
    });
    return {
      "fetchlet.json": readFileSync(join(outDir, "fetchlet.json"), "utf8"),
      "server.js": readFileSync(join(outDir, "server.js"), "utf8"),
    };
  }
}

/** The Node built-ins fetchlet implements, by name without `node:`. */
function nodeBuiltinNames(asyncContext: AsyncContextMode | undefined): string[] {
  return implementedNodeBuiltins.filter(
    (name) => !name.startsWith("node:") && (asyncContext !== undefined || name !== "async_hooks"),
  );
}

/**
 * The named function exports of the server module, read from Vite's server
 * transform, which declares each with `__vite_ssr_exportName__`. A function
 * exported later needs a dev server restart to be callable from Rust.
 */
async function exportedNames(environment: DevEnvironment, entry: string): Promise<string[]> {
  const result = await environment.transformRequest(entry);
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
