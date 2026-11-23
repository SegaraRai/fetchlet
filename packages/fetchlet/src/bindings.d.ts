// The types of the bindings the Rust host gives the application, shared by
// every framework integration.

export type {
  ChannelBinding,
  ChannelClose,
  ChannelStream,
  HostChannel,
} from "@fetchlet/web/channels";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Rust functions bound with `HostServices::functions`, as an object of
 * their methods. Declare each method as Rust implements it: one added with
 * `sync_method` returns its result, one added with `method` a Promise of it.
 * Arguments cross as `JSON.stringify` encodes them, except that an
 * `ArrayBuffer` or view crosses as its bytes. Results are JSON, with each
 * byte array Rust places in them as a `Uint8Array` and each channel as a
 * `HostChannel`.
 */
export type FunctionBinding<Methods extends { [name: string]: (...args: never[]) => unknown }> =
  Readonly<Methods>;

/**
 * The bindings of the fetchlet App, which `HostServices` defines in Rust.
 * Applications declare their keys here once, and every integration's
 * request context and `getBindings()` see them:
 *
 * ```ts
 * import type { ChannelBinding, FunctionBinding, ServiceBinding } from "fetchlet/bindings";
 *
 * declare module "fetchlet/bindings" {
 *   interface FetchletBindings {
 *     MESSAGE: string;
 *     RUST: ServiceBinding;
 *     PROGRESS: ChannelBinding;
 *     DB: FunctionBinding<{
 *       query(sql: string, params: unknown[]): Promise<unknown[]>;
 *       escape(text: string): string;
 *     }>;
 *   }
 * }
 * ```
 */
export interface FetchletBindings {}
