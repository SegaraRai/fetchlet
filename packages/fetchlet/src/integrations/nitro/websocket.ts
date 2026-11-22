import type { Nitro, RollupConfig } from "nitropack/types";

/** The Web API profile, whose `upgradeWebSocket` serves WebSocket upgrades. */
const RUNTIME_MODULE = "fetchlet/runtime/handler";

const denoAdapter = /[\\/]crossws[\\/]dist[\\/]adapters[\\/]deno\.mjs$/;

/**
 * Let crossws's Deno adapter serve WebSocket upgrades on the fetchlet App
 * host: its `Deno.upgradeWebSocket` becomes `upgradeWebSocket` from
 * fetchlet/runtime/handler, which takes the same request and returns the same
 * socket and response. Only that module sees the name, so the server bundle
 * defines no `Deno` global. The module stays an import for the artifact
 * build to bundle.
 */
export function websocketUpgrades(_nitro: Nitro, config: RollupConfig): void {
  const plugins = Array.isArray(config.plugins) ? config.plugins : [config.plugins];
  config.plugins = [
    {
      name: "fetchlet:nitro-websocket",
      resolveId(id: string) {
        return id === RUNTIME_MODULE ? { id, external: true } : null;
      },
      transform(code: string, id: string) {
        if (!denoAdapter.test(id)) {
          return null;
        }
        return {
          code:
            `import { upgradeWebSocket as fetchletUpgradeWebSocket } from ${JSON.stringify(RUNTIME_MODULE)};\n` +
            `const Deno = { upgradeWebSocket: fetchletUpgradeWebSocket };\n` +
            code,
          map: null,
        };
      },
    },
    ...plugins,
  ];
}
