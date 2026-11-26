---
title: Frameworks
slug: docs/frameworks
description: Choose the adapter of your framework. Each one is a subpath of the fetchlet npm package.
---

Install `fetchlet` as a development dependency alongside your framework. Every
framework adapter is a subpath of the `fetchlet` package, with framework
packages listed as optional peer dependencies.

```sh
vp i -D fetchlet
```

All adapters produce the same artifact layout (`server.js`, `client/`, and
`fetchlet.json`) and work with QuickJS, Boa, and V8.

| Framework                                         | Adapter subpath                                            | Dev server (`--vite`)     | Example                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| [Astro](/docs/frameworks/astro)                   | `fetchlet/astro`, `fetchlet/astro/server`                  | Yes (`devServer: true`)   | [astro-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/astro-axum)                   |
| [Hono and HonoX](/docs/frameworks/hono)           | `fetchlet/hono/vite`, `fetchlet/hono/conninfo`             | Rebuild                   | [honox-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/honox-axum)                   |
| [Nuxt and Nitro](/docs/frameworks/nitro)          | `fetchlet/nitro`, `fetchlet/nitro/types`                   | Rebuild                   | [nuxt-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/nuxt-axum)                     |
| [Qwik City](/docs/frameworks/qwik-city)           | `fetchlet/qwik-city/vite`, `fetchlet/qwik-city/middleware` | Rebuild                   | [qwik-city-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/qwik-city-axum)           |
| [React Router](/docs/frameworks/react-router)     | `fetchlet/react-router`, `fetchlet/react-router/context`   | Yes (`fetchletDevServer`) | [react-router-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/react-router-axum)     |
| [Solid](/docs/frameworks/solid)                   | `fetchlet/solid`, `fetchlet/solid/context`                 | Yes                       | [solid-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/solid-axum)                   |
| [SolidStart](/docs/frameworks/solid-start)        | `fetchlet/solid-start`, `fetchlet/solid-start/context`     | Yes                       | [solidstart-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/solidstart-axum)         |
| [SvelteKit](/docs/frameworks/sveltekit)           | `fetchlet/sveltekit`                                       | Rebuild                   | [sveltekit-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/sveltekit-axum)           |
| [TanStack Start](/docs/frameworks/tanstack-start) | `fetchlet/tanstack-start`                                  | Yes                       | [tanstack-start-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/tanstack-start-axum) |
| [vinext](/docs/frameworks/vinext)                 | `fetchlet/vinext`, `fetchlet/vinext/context`               | Rebuild                   | [vinext-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/vinext-axum)                 |
| [Waku](/docs/frameworks/waku)                     | `fetchlet/waku`, `fetchlet/waku/context`                   | Rebuild                   | [waku-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/waku-axum)                     |
| [Vite](/docs/frameworks/vite)                     | `fetchlet/vite`, `fetchlet/vite/client-assets`             | Yes                       | [vanilla-axum](https://github.com/SegaraRai/fetchlet/tree/main/examples/vanilla-axum)               |

## Without a framework adapter

- **Using Vite without a framework:** use [`fetchlet/vite`](/docs/frameworks/vite) for a standard `fetch(request, env, ctx)` server module plus browser entries.
- **Without Vite:** use the [`fetchlet build` command](/docs/javascript/build#the-fetchlet-build-command) or call `buildArtifact` from [`fetchlet/build`](/docs/javascript/build).

## Unsupported frameworks

Next.js (`next build` output — use [vinext](/docs/frameworks/vinext) instead), Qwik 2, and SolidStart builds targeting Nitro are not supported.

## Common notes across frameworks

- **WebAssembly:** QuickJS and Boa do not provide `WebAssembly`. If your app or its dependencies require WebAssembly, build for and run on the `v8` backend ([Engine limits](/docs/javascript/build#engine-limits)).
- **Static assets:** All adapters accept `assets: true` (or a custom configuration) to pack `client/` into a compressed `assets.flpk` archive for fast serving and single-binary embedding ([Asset archive](/docs/reference/asset-archive)).
