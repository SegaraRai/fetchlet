# Research: a Nitro 3 preset

`fetchlet/nitro` is a Nitro 2 preset: it imports `useNitroApp` from
`nitropack/runtime` and `toWebHandler` from h3 1, and declares `h3` ^1.0.0
and `nitropack` ^2.0.0 as optional peers. This records what a preset for
Nitro 3, which runs on h3 2, needs, and when to build it.

## Status

Checked on 2026-11-25 against the npm registry and Nitro's sources on
GitHub `main`.

| Package                 | Latest                                                  | Nitro                                                                                        |
| ----------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `nitro`                 | 3.0.261103-rc (beta from June, RC from 29 October 2026) | Nitro 3 itself; no stable release yet                                                        |
| `nitropack`             | 2.x                                                     | Nitro 2, which Nuxt 4.6.4 in examples/nuxt-axum runs                                         |
| `nuxt`                  | 4.7.0                                                   | `nitropack` ^2.14.0 and h3 ^1.15.11 through `@nuxt/nitro-server`; no Nuxt release on Nitro 3 |
| `h3`                    | 2.0.8 (`1x` tag: 1.15.11)                               | h3 2 is Nitro 3's                                                                            |
| `@solidjs/start`        | 2.2.3                                                   | h3 2 directly, no Nitro dependency                                                           |
| `@tanstack/react-start` | 1.169.7                                                 | No Nitro dependency                                                                          |

Nitro 3 is a Vite plugin (`nitro/vite`) as well as a standalone server
builder, and its documentation shows it added to SolidStart, TanStack
Start, React Router and Vue Router apps. No framework release depends on
it yet. fetchlet's SolidStart and TanStack Start adapters already handle
h3 2 through their own Vite integrations and do not import h3, so a Nitro 3
preset serves Nitro 3 apps and frameworks that adopt it later, such as a
future Nuxt.

## What changes for the preset

From Nitro's migration guide, its RC announcement and the sources of the
`base-worker`, `deno-server` and `cloudflare-module` presets:

- **Packages.** `nitropack` becomes `nitro`; `nitropack/runtime/*` becomes
  `nitro/*` (`nitro/app` exports `useNitroApp`), types come from
  `nitro/types`, and `nitropack/presets` is gone. Nitro 3 needs Node
  22.22.0 or later to build.
- **Preset object.** `NitroPreset` is a `NitroConfig` or a function that
  returns one; `defineNitroPreset` only adds `_meta` and resolves a
  relative `entry` against Nitro's own presets directory, so a third-party
  preset gives an absolute `entry`, as `fetchlet/nitro` already does with
  `createRequire(import.meta.url).resolve`. `extends`, `entry`, `output`,
  `serveStatic`, `minify`, `hooks` and `rollupConfig` keep their meaning;
  `rolldownConfig`, `builtinModules`, `alias`, `inject` and
  `buildPlugins` are new, and `unenv` remains only as a deprecated legacy
  option.
- **Resolving the preset.** The `preset` string goes through c12 with
  `preset` as an extend key; built-in names, aliases and standard names
  match first, and other ids fall to c12, which is expected to load a
  package or path as Nitro 2 did (not yet verified). `nitro dev` replaces
  any preset that is not built in with `nitro-dev`, so the preset applies
  to builds only, as today. The migration guide says external presets are
  "only for evaluation purposes" and asks for built-in ones, so a
  third-party preset is supported less formally than in Nitro 2.
- **Bundler.** Rolldown is the default. The `rollup:before` hook, which
  `fetchlet/nitro` uses for WebSocket upgrades, is renamed `build:config`
  and receives `{ builder, rolldown }` or `{ builder, rollup }`; the old
  name still runs with a warning. `compiled`, which writes the artifact,
  remains.
- **Runtime entry.** The entry imports `#nitro/virtual/polyfills` in place
  of `#nitro-internal-pollyfills`, takes the app from `useNitroApp()` of
  `nitro/app` and calls `nitroApp.fetch(request)` in place of
  `toWebHandler(nitroApp.h3App)`. Built-in presets do not pass a context
  object: they attach it to the Request. `cloudflare-module` sets
  `request.ip`, `request.waitUntil` and `request.runtime.cloudflare`, and
  h3 2's `getRequestIP` reads `request.context.clientAddress` or
  `request.ip`. fetchlet's SolidStart integration already defines `ip`,
  `waitUntil` and `runtime.fetchlet` on the Request this way, so the Nitro
  3 entry can share that code, and `event.context.fetchlet` becomes
  `event.req.runtime.fetchlet`.
- **WebSockets.** `features.websocket` enables them; entries still use a
  crossws adapter behind `import.meta._websocket`, now called with
  `{ resolve: resolveWebsocketHooks }`. The Deno adapter that
  `fetchlet/nitro` passes `upgradeWebSocket` to remains usable.
- **Declarations.** `fetchlet/nitro` augments h3 1's `H3EventContext` with
  `fetchlet`. With h3 2 the context lives on the Request's `runtime`, so the
  declarations augment h3 2's request runtime type instead.

## Proposal

- A separate subpath, `fetchlet/nitro3` (preset, runtime and declarations),
  rather than one preset for both: the two import different packages
  (`nitropack` and `nitro`), use different h3 majors and attach the context
  differently, and an app selects one by name. `nitro` becomes a third
  optional peer, and the `h3` peer widens to `^1.0.0 || ^2.0.0` once both
  presets are verified, as [TODO](../TODO.md#nitro-3-and-h3-2) states.
- Shared parts move out of `fetchlet/nitro`: the Node built-in mapping, the
  artifact writer and the WebSocket upgrade rewrite, with the hook name
  chosen per major.
- An example, `examples/nitro-axum`, built with `nitro/vite` and checked
  with the shared example suite, until a framework release runs on Nitro 3.

Next: build the preset against the Nitro 3 RC with the example, and
publish it once Nitro 3 is stable, since the preset API may still move
before then.

Sources: [Nitro migration guide](https://nitro.build/docs/migration),
[Nitro 3 RC announcement](https://nitro.build/blog/v3-rc),
[Nitro presets source](https://github.com/nitrojs/nitro/tree/main/src/presets),
[h3 request utilities](https://github.com/h3js/h3/blob/main/src/utils/request.ts),
[fetchlet/nitro preset](../../packages/fetchlet/src/integrations/nitro/preset.ts),
[SolidStart integration](../../packages/fetchlet/src/integrations/solid-start/index.ts).
