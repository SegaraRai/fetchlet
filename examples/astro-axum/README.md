# Astro + axum

Astro renders dynamic HTML and endpoints, served by axum. A Svelte island
hydrates in the browser; try the counter, the form and Astro's client
navigation.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-astro-axum#serve
```

Open `http://127.0.0.1:3100`. Rust runs QuickJS, and the adapter adds
FormatJS for Astro's `Intl.DateTimeFormat` requirement and its dependencies.
The host uses the same `AppHandle` and fetchlet-http APIs as the SvelteKit
example.

## Develop

```bash
vp run @fetchlet-internal/example-astro-axum#dev
```

The task builds once and starts the server with the `dev` feature. Whenever
a file in `web/` or `astro.config.ts` changes, it runs the `build` task
again; the server's `DevReload` starts each new build and open pages reload.
A failed build leaves the previous one serving. Changes to the Rust sources
need a restart.

## Develop from Vite

```bash
vp run @fetchlet-internal/example-astro-axum#dev:vite
```

The task starts `astro dev` on `127.0.0.1:3101`, then the server with the
`vite-dev` feature, which runs Astro's development app from Vite on QuickJS
(`tools/examples/vite-dev.ts`). Open `http://127.0.0.1:3100`. An edit to a
page renders on the next request and reloads the open page; island edits
refresh in place; endpoints run on the engine.

## Layout and configuration

`web/` holds Astro's pages, endpoints, Svelte components and assets.
`astro.config.ts` sets the backend to `quickjs` and can configure Intl
locales and time zone data (default: `en` and UTC). A `backend: "v8"` build
leaves FormatJS out of the bundle; the Rust side then uses `Backend::v8()`
and the `v8` feature ([builder](../../packages/fetchlet/docs/build.md)).

`astro.config.ts` holds the framework configuration and `vite.config.ts`
the Vite+ tasks. `src/` only starts Rust, sets bindings and routes.

`AppHandle` manages the thread, queue, cancellation and instance
rebuilding, and `FetchletService` converts HTTP and passes the client
address. Rust services and `MESSAGE` are read from `Astro.locals.env`.

`config.json` sets the listen address, body budgets, deadline and build
directory. This local example uses a 1 MiB request body
and a 10-second cooperative deadline; `public_origin` sets the origin
outside a proxy. Configuration works as in the SvelteKit example.

Rendering uses Astro with Svelte 5's synchronous SSR. Astro streams the page
in order, so `/deferred` sends its start while a component awaits. Request bodies reach endpoints as a `ReadableStream`
through `stream_request_bodies()`; `/api/upload` counts bytes as they
arrive. A body whose `Content-Length` declares more than the budget is
refused with 413 before execution; undeclared excess errors the endpoint's
stream. `/api/background` registers work with `Astro.locals.waitUntil`,
which the worker finishes before the next request (`background_timeout_ms`
and `background_tasks` in `config.json`). Cookies are set for local HTTP;
set `secure` behind HTTPS.

## Checks

```bash
vp run setup:browser
vp run test:examples -- astro-axum
```

Set `FETCHLET_BROWSER_CHANNEL=chrome` to use an installed Chrome. The checks
cover SSR, escaping, assets, JSON endpoints, forms, cookies, context, the
Rust route, budgets, streaming uploads, concurrent requests, island
hydration and client navigation. Results go to
`results/example-astro-axum.json`.
`tests/vite-dev.test.ts` runs the `dev:vite` loop
(`tools/examples/vite-dev-suite.ts`): SSR with a Rust service binding and
styles from Vite, endpoints, island hydration and navigation, and a page
edit that renders on the next request and reloads the open page, recorded
in `results/example-astro-axum-vite-dev.json` and its V8 variant. It
skips Boa: Astro's client router cancels a request when it navigates,
which retires the instance, and a debug build of Boa takes about 40 seconds
to evaluate Astro's development modules again.
