# fetchlet

Builds JavaScript web frameworks into artifacts that a Rust server runs through the [fetchlet](https://fetchlet.roundtrip.dev/docs/rust/fetchlet) crate. An artifact is a directory holding `server.js` (one IIFE bundle with a Fetch handler), `client/` (public assets) and `fetchlet.json` (the manifest that [fetchlet-http](https://fetchlet.roundtrip.dev/docs/rust/fetchlet-http)'s `Artifact` reads).

Install it as a development dependency next to your framework. Each framework has its own subpath, and the framework packages are optional peer dependencies. The build runs on Node 20.19, 22.12, 24 or later, the versions Vite 8 and Rolldown require; the repository tests it on Node 26.

```sh
npm install --save-dev fetchlet
```

| Subpath                                                    | Use                                                   | Guide                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `fetchlet/sveltekit`                                       | SvelteKit adapter                                     | [sveltekit](https://fetchlet.roundtrip.dev/docs/frameworks/sveltekit)           |
| `fetchlet/astro`, `fetchlet/astro/server`                  | Astro adapter                                         | [astro](https://fetchlet.roundtrip.dev/docs/frameworks/astro)                   |
| `fetchlet/nitro`, `fetchlet/nitro/types`                   | Nitro preset, also for Nuxt                           | [nitro](https://fetchlet.roundtrip.dev/docs/frameworks/nitro)                   |
| `fetchlet/react-router`, `fetchlet/react-router/context`   | React Router preset                                   | [react-router](https://fetchlet.roundtrip.dev/docs/frameworks/react-router)     |
| `fetchlet/hono/vite`, `fetchlet/hono/conninfo`             | Hono and HonoX Vite plugin                            | [hono](https://fetchlet.roundtrip.dev/docs/frameworks/hono)                     |
| `fetchlet/tanstack-start`                                  | TanStack Start Vite plugin                            | [tanstack-start](https://fetchlet.roundtrip.dev/docs/frameworks/tanstack-start) |
| `fetchlet/solid`, `fetchlet/solid/context`                 | Solid 2 Vite plugin                                   | [solid](https://fetchlet.roundtrip.dev/docs/frameworks/solid)                   |
| `fetchlet/solid-start`, `fetchlet/solid-start/context`     | SolidStart (Solid 1) Vite plugin                      | [solid-start](https://fetchlet.roundtrip.dev/docs/frameworks/solid-start)       |
| `fetchlet/qwik-city/vite`, `fetchlet/qwik-city/middleware` | Qwik City Vite plugin and middleware                  | [qwik-city](https://fetchlet.roundtrip.dev/docs/frameworks/qwik-city)           |
| `fetchlet/waku`, `fetchlet/waku/context`                   | Waku server entry adapter                             | [waku](https://fetchlet.roundtrip.dev/docs/frameworks/waku)                     |
| `fetchlet/vinext`, `fetchlet/vinext/context`               | vinext Vite plugin                                    | [vinext](https://fetchlet.roundtrip.dev/docs/frameworks/vinext)                 |
| `fetchlet/vite`, `fetchlet/vite/client-assets`             | Vite plugin for a server module without a framework   | [vite](https://fetchlet.roundtrip.dev/docs/frameworks/vite)                     |
| `fetchlet/build`                                           | `buildArtifact`, for adapters of other frameworks     | [build](https://fetchlet.roundtrip.dev/docs/javascript/build)                   |
| `fetchlet/runtime`, `/adapter`, `/handler`                 | The Web API profile and Fetch entry inside the bundle | [runtime](https://fetchlet.roundtrip.dev/docs/javascript/runtime)               |

The `fetchlet` command runs `fetchlet build`, which builds a server module into an artifact without Vite ([build](https://fetchlet.roundtrip.dev/docs/javascript/build#the-fetchlet-build-command)), and `fetchlet dev`, which rebuilds the artifact on source changes while a Rust host serves each build ([dev](https://fetchlet.roundtrip.dev/docs/javascript/dev)).

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

Every adapter calls `fetchlet/build`, which initializes `fetchlet/runtime` and the polyfills the target engine needs before the framework's modules, and writes the artifact.

## Documentation

The documentation is at <https://fetchlet.roundtrip.dev/docs>. This package also ships it as Markdown in `node_modules/fetchlet/docs/`, with an index in `docs/llms.txt`, so that coding agents read the version the application installed. `skills/` holds skills for coding agents, and `AGENTS_TEMPLATE.md` a section for a project's instruction file; [Coding agents](https://fetchlet.roundtrip.dev/docs/agents) describes them.

## Development

The workspace uses the sources in `src/` directly: `build/`, `runtime/` and the framework integrations in `integrations/`. The guest Web API implementations come from [`@fetchlet/web`](https://github.com/SegaraRai/fetchlet/blob/main/packages/web/README.md) and the `node:*` modules from [`@fetchlet/node`](https://github.com/SegaraRai/fetchlet/blob/main/packages/node/README.md), both dependencies released with fetchlet under the same version. The sources are TypeScript; `vp run fetchlet#build` compiles every exported module and its declarations into `dist/`, and the published manifest (`publishConfig.exports`) points at `dist/`. `vp run test:package` packs the three packages, installs them from their tarballs in a separate project, type-checks its declarations, builds and runs an artifact on QuickJS with `fetchlet/build` and with the packed `fetchlet build` command, and runs the packed `fetchlet dev` command.
