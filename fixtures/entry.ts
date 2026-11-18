import "fetchlet/runtime";
import "./probe/web-api.js";

export * from "./async-context";
export * from "./functions";
export { handle } from "./hono";
export * from "./host";
export * from "./node-crypto";
export * from "./node-modules";

export async function probe() {
  return globalThis.fetchletProbe({
    runtimeLabel: "embedded portable profile",
  });
}
