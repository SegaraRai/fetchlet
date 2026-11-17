import { getLoadContext } from "fetchlet/react-router/context";
import type { RouterContextProvider } from "react-router";

/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The host bindings src/services.rs registers. */
export interface Bindings {
  readonly MESSAGE: string;
  readonly RUST: ServiceBinding;
}

/** The fetchlet values of this request, typed with the example's bindings. */
export function fetchlet(context: Readonly<RouterContextProvider>) {
  return getLoadContext<Bindings>(context);
}
