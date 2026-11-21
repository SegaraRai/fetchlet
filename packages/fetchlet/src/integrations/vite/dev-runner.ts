// The server side of `fetchlet/vite` development serving, bundled into the
// development artifact the plugin builds. It runs inside the fetchlet engine
// and loads the server module from the Vite dev server through Vite's module
// runner, over the host binding that fetchlet-http's `ViteDev` registers.

import {
  type EvaluatedModuleNode,
  type ModuleEvaluator,
  type ModuleRunnerContext,
  ModuleRunner,
  ssrDynamicImportKey,
  ssrExportAllKey,
  ssrExportNameKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrModuleExportsKey,
} from "vite/module-runner";

import { createFetchHandler, getBindings, waitUntil } from "../../runtime/adapter.ts";

/** The binding name of the Vite dev server, shared with fetchlet-http. */
export const VITE_BINDING = "FETCHLET_VITE";

/** The origin requests to the binding use; the host sends them to Vite. */
const VITE_ORIGIN = "http://vite.fetchlet.internal";

interface ViteBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface UpdateResult {
  version: number;
  invalidated: string[];
  /** Every evaluated module is stale. */
  reset: boolean;
}

// Indirect eval runs the module's function as a script, so the functions a
// module declares keep their source text: Boa's Function constructor gives
// its functions none, and libraries such as seroval serialize functions by
// their source.
// eslint-disable-next-line no-eval -- The runner evaluates the modules Vite transformed.
const evaluateScript = eval;

/**
 * Evaluates the code Vite transformed for the server environment, as Vite's
 * ESModulesEvaluator does. Every dependency is transformed by Vite; the only
 * external modules are Node built-ins, which come from the development
 * artifact's own implementations.
 */
class FetchletEvaluator implements ModuleEvaluator {
  readonly #globalNames: string[];
  readonly #globalValues: unknown[];
  readonly #builtins: Readonly<Record<string, unknown>>;

  constructor(
    builtins: Readonly<Record<string, unknown>>,
    globals: Readonly<Record<string, unknown>>,
  ) {
    this.#builtins = builtins;
    this.#globalNames = Object.keys(globals);
    this.#globalValues = Object.values(globals);
  }

  async runInlinedModule(
    context: ModuleRunnerContext,
    code: string,
    module: Readonly<EvaluatedModuleNode>,
  ): Promise<void> {
    try {
      await this.#evaluate(context, code);
    } catch (error) {
      // The engines' stacks name no file for evaluated code, so the error
      // names the module whose evaluation failed.
      if (error instanceof Error && !error.message.includes(" (evaluating ")) {
        error.message += ` (evaluating ${module.id})`;
      }
      throw error;
    }
  }

  async #evaluate(context: ModuleRunnerContext, code: string): Promise<void> {
    const parameters = [
      ssrModuleExportsKey,
      ssrImportMetaKey,
      ssrImportKey,
      ssrDynamicImportKey,
      ssrExportAllKey,
      ssrExportNameKey,
      ...this.#globalNames,
    ].join(", ");
    // The block lets the module declare names the parameters also use.
    const run = evaluateScript(
      `(async function (${parameters}) {"use strict";{\n${code}\n}\n})`,
    ) as (...args: unknown[]) => Promise<unknown>;
    await run(
      context[ssrModuleExportsKey],
      context[ssrImportMetaKey],
      context[ssrImportKey],
      context[ssrDynamicImportKey],
      context[ssrExportAllKey],
      context[ssrExportNameKey],
      ...this.#globalValues,
    );
    Object.seal(context[ssrModuleExportsKey]);
  }

  async runExternalModule(file: string): Promise<unknown> {
    const name = file.startsWith("node:") ? file.slice("node:".length) : file;
    if (Object.hasOwn(this.#builtins, name)) {
      return this.#builtins[name];
    }
    throw new Error(
      `${file} is external to the Vite server environment; the engine loads only modules Vite transforms and the Node built-ins fetchlet implements`,
    );
  }
}

function vite(): ViteBinding {
  const binding = (getBindings() as Record<string, unknown>)[VITE_BINDING] as
    | ViteBinding
    | undefined;
  if (!binding) {
    throw new Error(
      `The ${VITE_BINDING} binding is missing; register fetchlet-http's ViteDev binding`,
    );
  }
  return binding;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await vite().fetch(VITE_ORIGIN + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`The Vite dev server answered ${path} with ${response.status}`);
  }
  return (await response.json()) as T;
}

/** The bindings without the Vite dev server's, as the server module sees them. */
function applicationBindings(): Record<string, unknown> {
  const { [VITE_BINDING]: _vite, ...env } = getBindings() as Record<string, unknown>;
  return env;
}

/** What the request context of the Rust host carries. */
export interface DevRequestContext {
  clientAddress?: string;
}

/** The server module's handling of one request. */
export type DevDispatch = (
  module: Record<string, unknown>,
  request: Request,
  env: Record<string, unknown>,
  ctx: DevRequestContext & { waitUntil(promise: unknown): void },
) => Response | Promise<Response>;

export interface DevServerOptions {
  /**
   * Calls the server module for a request. Defaults to the Workers module
   * shape: `default.fetch(request, env, ctx)`.
   */
  dispatch?: DevDispatch;
  /** Node built-in modules by name without `node:`, for external imports. */
  builtins?: Readonly<Record<string, unknown>>;
  /**
   * Node globals the Web API profile lacks, such as `process` and `Buffer`,
   * in scope of every module without being installed on `globalThis`, as
   * fetchlet/build injects them.
   */
  globals?: Readonly<Record<string, unknown>>;
}

/** The Workers module shape: the default export's `fetch(request, env, ctx)`. */
const workersDispatch: DevDispatch = (module, request, env, ctx) => {
  const server = module.default as
    | { fetch?: (request: Request, env: unknown, ctx: unknown) => Response | Promise<Response> }
    | undefined;
  if (typeof server?.fetch !== "function") {
    throw new TypeError("The server module's default export has no fetch method");
  }
  return server.fetch(request, env, {
    ...ctx,
    passThroughOnException() {},
    props: {},
  });
};

/**
 * The exports of a development artifact: a Fetch handler and a caller of
 * named exports, both over the server module `entry` as the Vite dev server
 * currently transforms it. Before each call, modules changed since the last
 * one are invalidated with their importers, so the next import evaluates
 * them again.
 */
export function devServer(
  entry: string,
  { dispatch = workersDispatch, builtins = {}, globals = {} }: DevServerOptions = {},
) {
  let runner: ModuleRunner | undefined;
  let version: number | undefined;

  async function load(): Promise<Record<string, unknown>> {
    runner ??= new ModuleRunner(
      {
        transport: {
          invoke: (payload) => post("/@fetchlet/invoke", payload),
        },
        hmr: false,
        sourcemapInterceptor: false,
      },
      new FetchletEvaluator(builtins, globals),
    );
    const update = await post<UpdateResult>("/@fetchlet/updates", { since: version ?? null });
    if (version !== undefined && update.reset) {
      // Vite reloaded the environment, as when it optimized dependencies again.
      runner.clearCache();
    } else if (version !== undefined) {
      for (const id of update.invalidated) {
        for (const node of modulesWithId(runner, id)) {
          runner.evaluatedModules.invalidateModule(node);
        }
      }
    }
    version = update.version;
    try {
      return (await runner.import(entry)) as Record<string, unknown>;
    } catch (error) {
      // Vite optimizes dependencies it discovers while the modules load and
      // then reloads the environment; the modules load again once.
      const retry = await post<UpdateResult>("/@fetchlet/updates", { since: version });
      if (!retry.reset) {
        throw error;
      }
      version = retry.version;
      runner.clearCache();
      return (await runner.import(entry)) as Record<string, unknown>;
    }
  }

  const handle = createFetchHandler(async (request, context: DevRequestContext | undefined) =>
    dispatch(await load(), request, applicationBindings(), {
      clientAddress: context?.clientAddress,
      waitUntil,
    }),
  );

  async function call(name: string, args: unknown[]): Promise<unknown> {
    const exported = (await load())[name];
    if (typeof exported !== "function") {
      throw new TypeError(`The server module has no function export ${name}`);
    }
    return exported(...args);
  }

  return {
    handle,
    call,
  };
}

function modulesWithId(runner: ModuleRunner, id: string): EvaluatedModuleNode[] {
  const node = runner.evaluatedModules.getModuleById(id);
  return node ? [node] : [];
}
