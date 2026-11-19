// The Web APIs the host implements (the fetchlet-web crate), so the profile
// installs only globals the host can serve. A host with another protocol
// version provides none of them, and the profile keeps its fallbacks.

import { hostFunctions } from "./host";

/** The fetchlet-web protocol this profile speaks. */
const PROTOCOL_VERSION = 3;

let provided: Set<string> | undefined;

/** Whether the host implements `api` ("url", "url-pattern", "compression", "crypto"). */
export function hostProvides(api: string): boolean {
  provided ??= capabilities();
  return provided.has(api);
}

function capabilities(): Set<string> {
  const host = hostFunctions();
  if (host === null) {
    return new Set();
  }
  try {
    const reply = JSON.parse(host.call("web.capabilities", "null"));
    if (reply.ok && reply.value.protocol === PROTOCOL_VERSION) {
      return new Set(reply.value.apis);
    }
  } catch {
    // A host without fetchlet-web provides no Web APIs.
  }
  return new Set();
}
