/// <reference types="astro/client" />

import type { ServiceBinding } from "fetchlet/runtime/adapter";

declare global {
  namespace App {
    interface Locals {
      env: {
        MESSAGE: string;
        RUST: ServiceBinding;
      };
      waitUntil(promise: Promise<unknown>): void;
    }
  }
}

export {};
