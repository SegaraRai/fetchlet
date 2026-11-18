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
