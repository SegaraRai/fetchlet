import "fetchlet/runtime";
import "./probe/web-api.js";

export * from "./async-context";
export * from "./functions";
export { handle } from "./hono";
export * from "./host";

export async function probe() {
  return globalThis.fetchletProbe({
    runtimeLabel: "embedded portable profile",
  });
}
