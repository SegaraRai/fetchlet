import { createContext, type RouterContext, type RouterContextProvider } from "react-router";

/** What the Rust server and the fetchlet host provide to each request. */
export interface FetchletLoadContext<Env = Readonly<Record<string, unknown>>> {
  /** The client address from the Rust request context, when it has one. */
  clientAddress?: string;
  /** The fixed host bindings of the fetchlet App. */
  env: Env;
  /**
   * Keep the invocation open until `promise` settles, after the response,
   * within the host's background budget.
   */
  waitUntil(promise: unknown): void;
}

/**
 * The fetchlet values in route middleware, loaders and actions:
 * `context.get(fetchletContext)`. The server build may inline this module
 * separately from the fetchlet entry, so every copy shares one key through
 * the global symbol registry.
 */
export const fetchletContext: RouterContext<FetchletLoadContext> = ((
  globalThis as { [key: symbol]: RouterContext<FetchletLoadContext> | undefined }
)[Symbol.for("fetchlet.react-router.context")] ??= createContext<FetchletLoadContext>());

/**
 * `context.get(fetchletContext)` with the app's own binding types, for
 * loaders, actions and middleware.
 */
export function getLoadContext<Env = Readonly<Record<string, unknown>>>(
  context: Readonly<RouterContextProvider>,
): FetchletLoadContext<Env> {
  return context.get(fetchletContext) as unknown as FetchletLoadContext<Env>;
}
