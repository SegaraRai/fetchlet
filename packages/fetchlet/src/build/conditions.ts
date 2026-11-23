/**
 * fetchlet's runtime key for package `exports`, following WinterTC Runtime
 * Keys. A package can offer a build for fetchlet under it.
 */
export const runtimeKey = "fetchlet";

/**
 * The export conditions that fetchlet resolves dependencies with, for
 * `mode`. Besides the runtime key, fetchlet implies only `worker`: Web APIs
 * as globals, with no DOM and no Node.js. It does not imply `workerd`,
 * `edge-light`, `browser` or `node`, whose builds may rely on Cloudflare
 * modules, a platform's edge APIs, the DOM or Node.js; an adapter adds one
 * only for a package that needs it, saying why.
 */
export function runtimeConditions(mode: "production" | "development" = "production"): string[] {
  return [runtimeKey, "worker", "module", "import", mode, "default"];
}
