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
}

const AsyncFunction = async function () {}.constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

/**
 * Evaluates the code Vite transformed for the server environment, as Vite's
 * ESModulesEvaluator does. Every dependency is transformed by Vite, so there
 * are no external modules to import natively.
 */
class FetchletEvaluator implements ModuleEvaluator {
  async runInlinedModule(context: ModuleRunnerContext, code: string): Promise<void> {
    const run = new AsyncFunction(
      ssrModuleExportsKey,
      ssrImportMetaKey,
      ssrImportKey,
      ssrDynamicImportKey,
      ssrExportAllKey,
      ssrExportNameKey,
      '"use strict";\n' + code,
    );
    await run(
      context[ssrModuleExportsKey],
      context[ssrImportMetaKey],
      context[ssrImportKey],
      context[ssrDynamicImportKey],
      context[ssrExportAllKey],
      context[ssrExportNameKey],
    );
    Object.seal(context[ssrModuleExportsKey]);
  }

  runExternalModule(file: string): Promise<never> {
    return Promise.reject(
      new Error(
        `${file} is external to the Vite server environment; fetchlet/vite transforms every dependency`,
      ),
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
    headers: { "content-type": "application/json" },
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

/**
 * The exports of a development artifact: a Fetch handler and a caller of
 * named exports, both over the server module `entry` as the Vite dev server
 * currently transforms it. Before each call, modules changed since the last
 * one are invalidated with their importers, so the next import evaluates
 * them again.
 */
export function devServer(entry: string) {
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
      new FetchletEvaluator(),
    );
    const update = await post<UpdateResult>("/@fetchlet/updates", { since: version ?? null });
    if (version !== undefined) {
      for (const id of update.invalidated) {
        for (const node of modulesWithId(runner, id)) {
          runner.evaluatedModules.invalidateModule(node);
        }
      }
    }
    version = update.version;
    return (await runner.import(entry)) as Record<string, unknown>;
  }

  const handle = createFetchHandler(
    async (request, context: { clientAddress?: string } | undefined) => {
      const server = (await load()).default as
        | { fetch?: (request: Request, env: unknown, ctx: unknown) => Response | Promise<Response> }
        | undefined;
      if (typeof server?.fetch !== "function") {
        throw new TypeError("The server module's default export has no fetch method");
      }
      return server.fetch(request, applicationBindings(), {
        waitUntil,
        passThroughOnException() {},
        props: {},
        clientAddress: context?.clientAddress,
      });
    },
  );

  async function call(name: string, args: unknown[]): Promise<unknown> {
    const exported = (await load())[name];
    if (typeof exported !== "function") {
      throw new TypeError(`The server module has no function export ${name}`);
    }
    return exported(...args);
  }

  return { handle, call };
}

function modulesWithId(runner: ModuleRunner, id: string): EvaluatedModuleNode[] {
  const node = runner.evaluatedModules.getModuleById(id);
  return node ? [node] : [];
}
