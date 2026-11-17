# fetchlet

Builds JavaScript web frameworks into artifacts that a Rust server runs through the [fetchlet](../../crates/fetchlet/README.md) crate. An artifact is a directory holding `server.js` (one IIFE bundle with a Fetch handler), `client/` (public assets) and `fetchlet.json` (the manifest that [fetchlet-http](../../crates/fetchlet-http/README.md)'s `Artifact` reads).

Install it as a development dependency next to your framework. Each framework has its own subpath, and the framework packages are optional peer dependencies.

| Subpath                                                    | Use                                                   | Guide                                    |
| ---------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| `fetchlet/sveltekit`                                       | SvelteKit adapter                                     | [sveltekit](docs/sveltekit.md)           |
| `fetchlet/astro`, `fetchlet/astro/server`                  | Astro adapter                                         | [astro](docs/astro.md)                   |
| `fetchlet/nitro`, `fetchlet/nitro/types`                   | Nitro preset, also for Nuxt                           | [nitro](docs/nitro.md)                   |
| `fetchlet/react-router`, `fetchlet/react-router/context`   | React Router preset                                   | [react-router](docs/react-router.md)     |
| `fetchlet/hono/vite`, `fetchlet/hono/conninfo`             | Hono and HonoX Vite plugin                            | [hono](docs/hono.md)                     |
| `fetchlet/tanstack-start`                                  | TanStack Start Vite plugin                            | [tanstack-start](docs/tanstack-start.md) |
| `fetchlet/solid-start`, `fetchlet/solid-start/context`     | SolidStart Vite plugin                                | [solid-start](docs/solid-start.md)       |
| `fetchlet/qwik-city/vite`, `fetchlet/qwik-city/middleware` | Qwik City Vite plugin and middleware                  | [qwik-city](docs/qwik-city.md)           |
| `fetchlet/waku`, `fetchlet/waku/context`                   | Waku server entry adapter                             | [waku](docs/waku.md)                     |
| `fetchlet/vinext`, `fetchlet/vinext/context`               | vinext Vite plugin                                    | [vinext](docs/vinext.md)                 |
| `fetchlet/build`                                           | `buildArtifact`, for adapters of other frameworks     | [build](docs/build.md)                   |
| `fetchlet/runtime`, `/adapter`, `/handler`                 | The Web API profile and Fetch entry inside the bundle | [runtime](docs/runtime.md)               |

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "fetchlet/sveltekit";

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

The workspace uses the sources in `src/` directly. `vp run fetchlet#build` compiles the TypeScript entries into `dist/` next to the JavaScript modules, and the published manifest (`publishConfig.exports`) points at `dist/`. `vp run test:package` packs the package, installs the tarball in a separate project, type-checks its declarations, and builds and runs an artifact on QuickJS.
