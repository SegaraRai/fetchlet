# fetchlet

Builds JavaScript web frameworks into artifacts that a Rust server runs through the [fetchlet](../../crates/fetchlet/README.md) crate. An artifact is a directory holding `server.js` (one IIFE bundle with a Fetch handler), `client/` (public assets) and `fetchlet.json` (the manifest that [fetchlet-http](../../crates/fetchlet-http/README.md)'s `Artifact` reads).

Install it as a development dependency next to your framework. Each framework has its own subpath, and the framework packages are optional peer dependencies. The build runs on Node 20.19, 22.12, 24 or later, the versions Vite 8 and Rolldown require; the repository tests it on Node 26.

| Subpath                                                    | Use                                                   | Guide                                    |
| ---------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| `fetchlet/sveltekit`                                       | SvelteKit adapter                                     | [sveltekit](docs/sveltekit.md)           |
| `fetchlet/astro`, `fetchlet/astro/server`                  | Astro adapter                                         | [astro](docs/astro.md)                   |
| `fetchlet/nitro`, `fetchlet/nitro/types`                   | Nitro preset, also for Nuxt                           | [nitro](docs/nitro.md)                   |
| `fetchlet/react-router`, `fetchlet/react-router/context`   | React Router preset                                   | [react-router](docs/react-router.md)     |
| `fetchlet/hono/vite`, `fetchlet/hono/conninfo`             | Hono and HonoX Vite plugin                            | [hono](docs/hono.md)                     |
| `fetchlet/tanstack-start`                                  | TanStack Start Vite plugin                            | [tanstack-start](docs/tanstack-start.md) |
| `fetchlet/solid`, `fetchlet/solid/context`                 | Solid 2 Vite plugin                                   | [solid](docs/solid.md)                   |
| `fetchlet/solid-start`, `fetchlet/solid-start/context`     | SolidStart (Solid 1) Vite plugin                      | [solid-start](docs/solid-start.md)       |
| `fetchlet/qwik-city/vite`, `fetchlet/qwik-city/middleware` | Qwik City Vite plugin and middleware                  | [qwik-city](docs/qwik-city.md)           |
| `fetchlet/waku`, `fetchlet/waku/context`                   | Waku server entry adapter                             | [waku](docs/waku.md)                     |
| `fetchlet/vinext`, `fetchlet/vinext/context`               | vinext Vite plugin                                    | [vinext](docs/vinext.md)                 |
| `fetchlet/vite`, `fetchlet/vite/client-assets`             | Vite plugin for a server module without a framework   | [vite](docs/vite.md)                     |
| `fetchlet/build`                                           | `buildArtifact`, for adapters of other frameworks     | [build](docs/build.md)                   |
| `fetchlet/runtime`, `/adapter`, `/handler`                 | The Web API profile and Fetch entry inside the bundle | [runtime](docs/runtime.md)               |

The `fetchlet` command runs `fetchlet build`, which builds a server module into an artifact without Vite ([build](docs/build.md#the-fetchlet-build-command)), and `fetchlet dev`, which rebuilds the artifact on source changes while a Rust host serves each build ([dev](docs/dev.md)).

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "fetchlet/sveltekit";
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: fetchletAdapter({
        out: "build",
      }),
    }),
  ],
});
```

Every adapter calls `fetchlet/build`, which initializes `fetchlet/runtime` and the polyfills the target engine needs before the framework's modules, and writes the artifact. The guides are being translated to English.

## Development

The workspace uses the sources in `src/` directly: `build/`, `runtime/` and the framework integrations in `integrations/`. The guest Web API implementations come from [`@fetchlet/web`](../web/README.md) and the `node:*` modules from [`@fetchlet/node`](../node/README.md), both dependencies released with fetchlet under the same version. The sources are TypeScript; `vp run fetchlet#build` compiles every exported module and its declarations into `dist/`, and the published manifest (`publishConfig.exports`) points at `dist/`. `vp run test:package` packs the three packages, installs them from their tarballs in a separate project, type-checks its declarations, builds and runs an artifact on QuickJS with `fetchlet/build` and with the packed `fetchlet build` command, and runs the packed `fetchlet dev` command.
