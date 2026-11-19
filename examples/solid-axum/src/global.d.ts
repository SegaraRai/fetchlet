/// <reference types="vite-plus/client" />
/// <reference types="@solidjs/vite-plugin/boundary-modules" />
/// <reference types="../file-routes.d.ts" />

import "fetchlet/solid/context";

declare module "fetchlet/solid/context" {
  interface FetchletBindings {
    MESSAGE: string;
    RUST: {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  }
}
