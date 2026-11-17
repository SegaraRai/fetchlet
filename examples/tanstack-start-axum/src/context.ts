import type { FetchletRequestContext } from "fetchlet/tanstack-start";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The host bindings src/services.rs registers. */
export interface Bindings {
  readonly MESSAGE: string;
  readonly RUST: ServiceBinding;
}

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: FetchletRequestContext<Bindings>;
    };
  }
}
