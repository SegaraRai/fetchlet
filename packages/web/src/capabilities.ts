// What this Web API profile needs from fetchlet-web, for fetchlet/build to
// record in an artifact's manifest. It has no side effects, so build tools
// import it in Node.

import { hostOperations } from "./internal/protocol.ts";

/**
 * The fetchlet-web protocol this profile speaks, `PROTOCOL_VERSION`: the
 * version of its operation names and messages. A host with another version
 * serves none of the profile's host Web APIs. `hostOperations` lists the
 * operations of each API. Both are written, with the host's copy, from
 * crates/fetchlet-web/protocol.json.
 */
export { hostOperations, PROTOCOL_VERSION } from "./internal/protocol.ts";

/** A fetchlet-web API, by the name `web.capabilities` reports. */
export type HostApi = Exclude<keyof typeof hostOperations, "web">;

/**
 * Global APIs that this profile installs only when the host serves them,
 * with the fetchlet-web APIs each needs, by the names `web.capabilities`
 * reports. A global with a fallback of its own, such as URL, is not listed.
 */
export const hostApiRequirements: Readonly<Record<string, readonly HostApi[]>> = {
  crypto: ["crypto"],
  "crypto.subtle": ["crypto"],
  CompressionStream: ["compression"],
  DecompressionStream: ["compression"],
  URLPattern: ["url-pattern"],
};
