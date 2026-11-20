import type { ServiceBinding } from "fetchlet/bindings";

declare module "fetchlet/bindings" {
  /** The host bindings server/services.rs registers. */
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
  }
}
