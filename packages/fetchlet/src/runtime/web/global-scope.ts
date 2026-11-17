// Globals of the WinterTC Minimum Common API that belong to the runtime
// rather than to a specific interface (https://min-common-api.proposal.wintertc.org/).

import { runtime } from "./runtime";

// The runtime identifies itself with a single product token (WinterTC §7).
if (runtime.navigator === undefined) {
  const navigator = Object.create({
    get [Symbol.toStringTag]() {
      return "Navigator";
    },
  });
  Object.defineProperty(navigator, "userAgent", {
    value: "fetchlet",
    enumerable: true,
  });
  runtime.navigator = navigator;
}

// The global scope is not an EventTarget here, so a reported exception has
// no error event to reach; it goes to the console, which the host captures.
runtime.reportError ??= function reportError(error: unknown) {
  if (arguments.length < 1) {
    throw new TypeError("reportError requires an argument");
  }
  runtime.console?.error?.("Uncaught", error);
};
