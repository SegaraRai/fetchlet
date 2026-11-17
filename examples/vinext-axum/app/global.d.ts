import type { ServiceBinding } from "fetchlet/vinext/context";

declare module "fetchlet/vinext/context" {
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
  }
}
