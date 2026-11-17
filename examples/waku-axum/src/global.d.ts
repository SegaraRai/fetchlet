import type { ServiceBinding } from "fetchlet/waku/context";

declare module "fetchlet/waku/context" {
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
  }
}
