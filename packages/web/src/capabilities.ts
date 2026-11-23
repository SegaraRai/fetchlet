// What this Web API profile needs from fetchlet-web, for fetchlet/build to
// record in an artifact's manifest. It has no side effects, so build tools
// import it in Node.

/**
 * The fetchlet-web protocol this profile speaks: the version of its
 * operation names and messages. A host with another version serves none of
 * the profile's host Web APIs. Bumped with `PROTOCOL_VERSION` in
 * crates/fetchlet-web.
 */
export const PROTOCOL_VERSION = 3;

/**
 * Global APIs that this profile installs only when the host serves them,
 * with the fetchlet-web APIs each needs, by the names `web.capabilities`
 * reports. A global with a fallback of its own, such as URL, is not listed.
 */
export const hostApiRequirements: Readonly<Record<string, readonly string[]>> = {
  crypto: ["crypto"],
  "crypto.subtle": ["crypto"],
  CompressionStream: ["compression"],
  DecompressionStream: ["compression"],
  URLPattern: ["url-pattern"],
};
