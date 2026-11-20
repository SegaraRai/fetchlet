// The types of the bindings the Rust host gives the application, shared by
// every framework integration.

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * The bindings of the fetchlet App, which `HostServices` defines in Rust.
 * Applications declare their keys here once, and every integration's
 * request context and `getBindings()` see them:
 *
 * ```ts
 * import type { ServiceBinding } from "fetchlet/bindings";
 *
 * declare module "fetchlet/bindings" {
 *   interface FetchletBindings {
 *     MESSAGE: string;
 *     RUST: ServiceBinding;
 *   }
 * }
 * ```
 */
export interface FetchletBindings {}
