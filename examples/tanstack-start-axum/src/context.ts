import type { ServiceBinding } from "fetchlet/bindings";
import type { FetchletRequestContext } from "fetchlet/tanstack-start";

declare module "fetchlet/bindings" {
  /** The host bindings server/services.rs registers. */
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
  }
}

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: FetchletRequestContext;
    };
  }
}
