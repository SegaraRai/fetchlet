import type { FetchletLoadContext } from "@fetchlet/react-router-preset/context";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The host bindings src/services.rs registers. */
export interface Bindings {
  readonly MESSAGE: string;
  readonly RUST: ServiceBinding;
}

declare module "react-router" {
  interface AppLoadContext extends FetchletLoadContext<Bindings> {}
}
