// Nitro's server entry for the fetchlet preset.

import { toWebHandler } from "h3";
import { useNitroApp } from "nitropack/runtime";

import "#nitro-internal-pollyfills";

const nitroApp = useNitroApp();

/**
 * Handle a Fetch Request with the Nitro app. The context becomes
 * `event.context`: h3 reads `clientAddress` for getRequestIP, and Nitro
 * registers `event.waitUntil` work through `waitUntil`.
 */
export const handler = toWebHandler(nitroApp.h3App);
