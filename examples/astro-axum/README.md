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

`config.json` sets the listen address, queue, body budgets, deadline and
build directory. This local example uses a queue of 8, a 1 MiB request body
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
