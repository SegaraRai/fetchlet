import type { ServiceBinding } from "@fetchlet/nitro-preset/types";

declare module "@fetchlet/nitro-preset/types" {
  interface FetchletBindings {
    NUXT_MESSAGE: string;
    RUST: ServiceBinding;
  }
}
