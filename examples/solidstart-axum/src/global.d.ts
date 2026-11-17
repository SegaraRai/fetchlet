/// <reference types="@solidjs/start/env" />

import "fetchlet/solid-start/context";

declare module "fetchlet/solid-start/context" {
  interface FetchletBindings {
    MESSAGE: string;
    RUST: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  }
}
