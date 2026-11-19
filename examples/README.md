# Examples

Each example has its own frontend build, Rust host, configuration, run
instructions and end-to-end checks. The axum examples are checked over real
HTTP in a browser, the Tauri examples in the webview, and the command line
example by running the program.

| Example                                                    | Backend           | Checks                                                                                                                                                   |
| ---------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SvelteKit + axum](sveltekit-axum/README.md)               | QuickJS           | SSR, assets, hydration, actions, endpoints, in-process Rust API, client navigation                                                                       |
| [Astro + axum](astro-axum/README.md)                       | QuickJS, FormatJS | SSR, assets, a Svelte island, forms, endpoints, Rust service, streaming uploads, client navigation                                                       |
| [Nuxt + axum](nuxt-axum/README.md)                         | QuickJS           | SSR, assets, hydration, server routes, runtime config, Rust service, navigation                                                                          |
| [React Router + axum](react-router-axum/README.md)         | QuickJS           | Streaming SSR, assets, hydration, actions, resource routes, Rust service, navigation                                                                     |
| [HonoX + axum](honox-axum/README.md)                       | QuickJS           | SSR, assets, islands, API routes, Rust service, navigation                                                                                               |
| [TanStack Start + axum](tanstack-start-axum/README.md)     | QuickJS           | Streaming SSR, assets, hydration, server functions, server routes, Rust service, client navigation                                                       |
| [SolidStart + axum](solidstart-axum/README.md)             | QuickJS           | Streaming SSR, assets, hydration, server functions, API routes, Rust service, client navigation                                                          |
| [Solid + axum](solid-axum/README.md)                       | QuickJS           | Solid 2 without SolidStart: streaming SSR, assets, hydration, server functions, API routes, Rust service, client navigation                              |
| [Vanilla JavaScript + axum](vanilla-axum/README.md)        | QuickJS           | A Vite-built fetch handler without a framework: streaming HTML, browser entries, endpoints, Rust service, named exports called from Rust                 |
| [Vanilla JavaScript CLI](vanilla-cli/README.md)            | QuickJS           | A module of functions only, without a Fetch handler: a command line program calls its exports with bindings, JSON arguments and Web Crypto               |
| [Qwik City + axum](qwik-city-axum/README.md)               | QuickJS           | SSR, assets, resumability, `routeLoader$`, endpoints, Rust service, client navigation                                                                    |
| [Waku + axum](waku-axum/README.md)                         | QuickJS           | RSC, SSR, assets, hydration, API routes, Rust service, client navigation                                                                                 |
| [vinext + axum](vinext-axum/README.md)                     | QuickJS           | App Router, RSC, SSR, assets, hydration, route handlers, Rust service, client navigation                                                                 |
| [HonoX + Tauri](honox-tauri/README.md)                     | QuickJS           | Serving over a URI scheme without an HTTP server, SSR, assets, islands, API routes, bundle functions from Tauri commands                                 |
| [SvelteKit + axum / Tauri](sveltekit-axum-tauri/README.md) | QuickJS           | A Markdown workspace: one router over CLI HTTP and a Tauri URI scheme, types from OpenAPI, remote functions, async SSR, Rust highlighting, file watching |

The framework examples share ten checks in `tools/examples/common-checks.ts`
for the same application shape. Next.js itself (`next build` output), Qwik 2
and SolidStart builds through Nitro are not covered.

Each axum example also has a `dev` task: `tools/examples/dev.ts` runs the
example's `build` task again whenever one of its source files changes, and
the server, built with the example's `dev` Cargo feature, serves each new
build through fetchlet-http's `DevReload` and reloads open pages. A full
build takes one to five seconds for these examples.

## Shared boundaries

Framework adapters produce the server bundle and client assets, and
`fetchlet/build` fixes the Web API initialization order and the artifact
format. On the Rust side, `AppHandle` runs the app. The axum examples read
the artifact with fetchlet-http's `Artifact` and serve client assets and the
app with `artifact_router`. The Tauri examples call fetchlet-http's
`FetchletService` from a URI scheme protocol and serve the webview without
an HTTP server. The same request handling contract is verified on the
Tower, hyper and actix-web layers.

An artifact is `server.js`, `client/` or `assets.flpk`, and `fetchlet.json`,
which records the format version, entry, profile, framework and required
capabilities. The application chooses the backend to match.

## Switching backends

Every example defaults to QuickJS. To run on Boa or V8, build the artifact
and the server for the same backend:

```bash
FETCHLET_BACKEND=v8 vp run --filter @fetchlet-internal/example-honox-axum build
```

```bash
node tools/workspace/cargo.ts run --release -p example-honox-axum --features v8
```

`FETCHLET_BACKEND` (`quickjs`, `boa` or `v8`) overrides the backend in the
framework configuration at build time, and `"backend": "v8"` in
`config.json` selects the Rust `Backend`. A server built without the feature
refuses a Boa or V8 configuration at startup. `worker_stack_bytes` also
applies to V8's worker thread.

[tools/bench](../tools/bench/README.md) measures requests per second for
each example, backend and endpoint.

## Adding an example

- Name it `<framework>-<rust-host>` (axum, tauri, …) and make it runnable.
- Register its Rust and JavaScript packages in the workspaces.
- Put framework-specific integration in an adapter of `packages/fetchlet`
  and HTTP integration in `crates/`.
- Reuse the framework's artifact with other Rust servers.
- Check HTML, public assets, hydration, navigation and the host features the
  example uses end to end.
- Record the framework and backend versions and the profile.

`tools/examples/suite.ts` starts test servers and records results;
`vp run test:examples` checks every example on QuickJS, and
`vp run test:examples -- --backends boa,v8,quickjs` on each engine; results
for Boa and V8 go to `example-<name>-<engine>.json`. The Tauri examples
drive WebView2 through the DevTools protocol.
