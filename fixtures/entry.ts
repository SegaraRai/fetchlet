import "@fetchlet/runtime";

import "../probes/web-api.js";

export * from "./functions";
export { handle } from "./hono";
export * from "./host";

export async function probe() {
  return globalThis.fetchletProbe({
    runtimeLabel: "embedded portable profile",
  });
}
