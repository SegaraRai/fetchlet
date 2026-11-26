# fetchlet

Framework adapters, artifact builder, CLI (`fetchlet dev` / `fetchlet build`),
and runtime helpers for running JavaScript web frameworks inside a Rust binary
with the [`fetchlet`](https://crates.io/crates/fetchlet) and
[`fetchlet-http`](https://crates.io/crates/fetchlet-http) crates.

Requires Node.js 20.19, 22.12, 24 or later at build time.

```sh
npm install --save-dev fetchlet
```

## Quick example (SvelteKit)

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "fetchlet/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: fetchletAdapter({
        out: "build",
        assets: true,
      }),
    }),
  ],
});
```

Running `vite build` writes `build/` containing `server.js`, `fetchlet.json`,
and client assets (or `assets.flpk` when `assets: true`).

## Adapters and subpaths

Each framework adapter is a subpath of `fetchlet` (framework packages are
optional peer dependencies):

| Subpath                                                      | Framework / Purpose                                 | Guide                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `fetchlet/tanstack-start`                                    | TanStack Start Vite plugin                          | [TanStack Start](https://fetchlet.roundtrip.dev/docs/frameworks/tanstack-start)       |
| `fetchlet/react-router`, `fetchlet/react-router/context`     | React Router preset                                 | [React Router](https://fetchlet.roundtrip.dev/docs/frameworks/react-router)           |
| `fetchlet/vinext`, `fetchlet/vinext/context`                 | vinext Vite plugin                                  | [vinext](https://fetchlet.roundtrip.dev/docs/frameworks/vinext)                       |
| `fetchlet/astro`, `fetchlet/astro/server`                    | Astro adapter                                       | [Astro](https://fetchlet.roundtrip.dev/docs/frameworks/astro)                         |
| `fetchlet/sveltekit`                                         | SvelteKit adapter                                   | [SvelteKit](https://fetchlet.roundtrip.dev/docs/frameworks/sveltekit)                 |
| `fetchlet/nitro`, `fetchlet/nitro/types`                     | Nuxt and Nitro preset                               | [Nuxt & Nitro](https://fetchlet.roundtrip.dev/docs/frameworks/nitro)                  |
| `fetchlet/solid-start`, `fetchlet/solid-start/context`       | SolidStart (Solid 1) Vite plugin                    | [SolidStart](https://fetchlet.roundtrip.dev/docs/frameworks/solid-start)              |
| `fetchlet/solid`, `fetchlet/solid/context`                   | Solid 2 Vite plugin                                 | [Solid](https://fetchlet.roundtrip.dev/docs/frameworks/solid)                         |
| `fetchlet/waku`, `fetchlet/waku/context`                     | Waku server entry adapter                           | [Waku](https://fetchlet.roundtrip.dev/docs/frameworks/waku)                           |
| `fetchlet/qwik-city/vite`, `fetchlet/qwik-city/middleware`   | Qwik City Vite plugin and middleware                | [Qwik City](https://fetchlet.roundtrip.dev/docs/frameworks/qwik-city)                 |
| `fetchlet/hono/vite`, `fetchlet/hono/conninfo`, `/websocket` | Hono and HonoX Vite plugin and helpers              | [Hono & HonoX](https://fetchlet.roundtrip.dev/docs/frameworks/hono)                   |
| `fetchlet/vite`, `fetchlet/vite/client-assets`               | Vite plugin for a server module without a framework | [Vite](https://fetchlet.roundtrip.dev/docs/frameworks/vite)                           |
| `fetchlet/build`                                             | Programmatic `buildArtifact` API                    | [Building](https://fetchlet.roundtrip.dev/docs/javascript/build)                      |
| `fetchlet/runtime`, `/adapter`, `/handler`                   | Web API profile, bindings, sockets, and WebSockets  | [Runtime](https://fetchlet.roundtrip.dev/docs/javascript/runtime)                     |
| `fetchlet/bindings`                                          | TypeScript types for `FetchletBindings`             | [Binding types](https://fetchlet.roundtrip.dev/docs/javascript/runtime#binding-types) |

## CLI

- **`fetchlet dev`** — watches sources or runs Vite dev behind your Rust host
  for live reload and HMR ([Development server](https://fetchlet.roundtrip.dev/docs/javascript/dev)).
- **`fetchlet build`** — compiles a standalone server module into a fetchlet
  artifact without Vite ([`fetchlet build`](https://fetchlet.roundtrip.dev/docs/javascript/build#the-fetchlet-build-command)).

## Documentation & coding agents

- **Website:** <https://fetchlet.roundtrip.dev/docs>
- **Bundled Markdown docs:** this package includes version-matched documentation
  in `node_modules/fetchlet/docs/` (indexed in `docs/llms.txt`), agent skills
  in `skills/`, and `AGENTS_TEMPLATE.md` for your project's instruction file
  ([Coding agents](https://fetchlet.roundtrip.dev/docs/agents)).
