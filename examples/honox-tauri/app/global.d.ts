import "hono";
import type { FetchletBindings, ServiceBinding } from "fetchlet/bindings";

declare module "fetchlet/bindings" {
  /** The host bindings src/services.rs registers. */
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
  }
}

declare module "hono" {
  interface Env {
    Bindings: FetchletBindings;
  }
}
