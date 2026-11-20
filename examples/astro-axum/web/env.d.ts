/// <reference types="astro/client" />

import type { FetchletBindings, ServiceBinding } from "fetchlet/bindings";

declare module "fetchlet/bindings" {
  /** The host bindings src/services.rs registers. */
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
  }
}

declare global {
  namespace App {
    interface Locals {
      env: FetchletBindings;
      waitUntil(promise: Promise<unknown>): void;
    }
  }
}
