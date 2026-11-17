import type { ServiceBinding } from "fetchlet/nitro/types";

declare module "fetchlet/nitro/types" {
  interface FetchletBindings {
    NUXT_MESSAGE: string;
    RUST: ServiceBinding;
  }
}
