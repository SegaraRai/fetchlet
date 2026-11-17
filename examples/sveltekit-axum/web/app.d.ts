import type { ServiceBinding } from "fetchlet/runtime/adapter";

declare global {
  namespace App {
    interface Platform {
      env: {
        MESSAGE: string;
        RUST: ServiceBinding;
      };
      context: {
        waitUntil(promise: Promise<unknown>): void;
      };
    }
  }
}

export {};
