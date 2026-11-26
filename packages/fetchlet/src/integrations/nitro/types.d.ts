import type { FetchletBindings as Bindings, ServiceBinding } from "fetchlet/bindings";

/**
 * The fixed host bindings of the fetchlet App: the keys applications declare
 * on `FetchletBindings` of fetchlet/bindings.
 */
export interface FetchletBindings extends Bindings {}

export type { ServiceBinding };

export interface FetchletNitroOptions {
  /** The engine the artifact targets. */
  backend?: "portable" | "quickjs" | "boa" | "v8";
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: {
    locales?: string[];
    timeZoneData?: "utc" | "golden" | "all";
    apis?: string[];
  };
  /**
   * APIs the application needs beyond the Web API profile, as in
   * fetchlet/build: Intl APIs such as `Intl.DateTimeFormat`, and globals over
   * host Web APIs such as `crypto.subtle`. Recorded in fetchlet.json, where
   * the Rust host checks them before the server runs.
   */
  requirements?: string[];
  /**
   * Also pack the client assets into `assets.flpk` for fetchlet-http to
   * serve or embed. `true` caches each `publicAssets` directory for its
   * `maxAge`; settings adjust that and add entries, and a function returns
   * every entry. See https://fetchlet.roundtrip.dev/docs/reference/asset-archive.
   */
  assets?: import("../../build/asset-option.ts").AssetsOption;
}

declare module "nitropack/types" {
  interface NitroConfig {
    fetchlet?: FetchletNitroOptions;
  }
  interface NitroOptions {
    fetchlet?: FetchletNitroOptions;
  }
}

declare module "h3" {
  interface H3EventContext {
    /** The client address the Rust server passed in the request context. */
    clientAddress?: string;
    /** Present for requests served by the fetchlet App. */
    fetchlet?: {
      env: Readonly<FetchletBindings>;
    };
  }
}
