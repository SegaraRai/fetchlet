import "hono";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

declare module "hono" {
  interface Env {
    Bindings: {
      MESSAGE: string;
      RUST: ServiceBinding;
    };
  }
}
