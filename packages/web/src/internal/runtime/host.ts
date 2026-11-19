// The fetchlet host functions. fetchlet's bridge takes them off the global
// object and hands them out once, through __fetchletClaimHost, while the
// bundle is evaluated; fetchlet removes that function after the bundle. This
// module claims them as it loads, so the profile and the Node.js modules
// share them and application code cannot reach them.

import { runtime } from "./runtime";

/** The host functions of a fetchlet engine. */
export interface Host {
  /** Run an operation: its name and JSON input, a JSON reply. */
  call(operation: string, input: string): string;
  /** Store bytes in the invocation's byte store; returns their handle. */
  putBytes(bytes: Uint8Array): number;
  /** Take the bytes the host stored under `handle`. */
  takeBytes(handle: number): Uint8Array;
}

let claimed: Host | null | undefined;

/** The host functions, or null outside a fetchlet engine. */
export function hostFunctions(): Host | null {
  if (claimed === undefined) {
    const claim = runtime.__fetchletClaimHost;
    claimed = typeof claim === "function" ? (claim() as Host) : null;
  }
  return claimed;
}

hostFunctions();
