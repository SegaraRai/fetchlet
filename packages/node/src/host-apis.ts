// The fetchlet-web APIs that each module of this package calls, by the
// names `web.capabilities` reports, for fetchlet/build to record in an
// artifact's manifest when the artifact imports the module. It has no side
// effects, so build tools import it in Node.

import type { HostApi } from "@fetchlet/web/capabilities";

/** Host Web APIs by Node module name, without the `node:` scheme. */
export const moduleHostApis: Readonly<Record<string, readonly HostApi[]>> = {
  // Hashes and key derivation run on nodeCrypto.*, ciphers and keys on crypto.*.
  crypto: ["crypto", "node-crypto"],
  zlib: ["compression"],
};
