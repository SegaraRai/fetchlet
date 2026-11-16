/** A host service binding: a fetch scoped by the Rust FetchPolicy. */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The fixed host bindings of the fetchlet App. Apps declare their own keys. */
export interface FetchletBindings {}

export interface FetchletNitroOptions {
  /** The engine the artifact targets. */
  backend?: "portable" | "quickjs" | "boa" | "v8";
  /** Intl data for engines without native Intl, as in @fetchlet/build. */
  intl?: {
    locales?: string[];
    timeZoneData?: "utc" | "golden" | "all";
    apis?: string[];
  };
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
    fetchlet?: { env: Readonly<FetchletBindings> };
  }
}
