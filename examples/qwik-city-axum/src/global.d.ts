import type { ServiceBinding } from "fetchlet/qwik-city/middleware";

declare module "fetchlet/qwik-city/middleware" {
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
  }
}
