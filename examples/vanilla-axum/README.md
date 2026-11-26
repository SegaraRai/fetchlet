# Vanilla JavaScript + axum

Serves a server module without a framework from axum. The module's default
export handles requests with `fetch(request, env, ctx)`, as a Cloudflare
Workers module does, and renders HTML that loads one browser entry. Its
named export `greet` is called directly from a Rust route.
[fetchlet/vite](https://fetchlet.roundtrip.dev/docs/frameworks/vite) builds both into an
artifact.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-vanilla-axum#serve
```

Open `http://127.0.0.1:3620`. The task builds, then starts the server on
QuickJS.

## Develop

```bash
vp run @fetchlet-internal/example-vanilla-axum#dev
```

The task keeps `vite build --watch` running and starts the server with the
`dev` feature once the first build is written. Vite rebuilds the client and
then the server after each change to a module they import, in a fraction of
a second; the server's `DevReload` starts each new build and open pages
reload. A failed build leaves the previous one serving. Changes to `public/`,
`vite.config.ts` or the Rust sources need a restart.

## Develop from Vite

```bash
vp run @fetchlet-internal/example-vanilla-axum#dev:vite
```

The task runs `fetchlet dev --vite`, which starts `vite dev` on a free port, then the server with the
`vite-dev` feature, which runs the server module from Vite on QuickJS. Open `http://127.0.0.1:3620`. A change to
`src/server.ts` takes effect on the next request and reloads open pages;
a change to `src/client.ts` or `src/styles.css` is applied in place. No
build is needed. To run on Boa, set `FETCHLET_BACKEND=boa` and pass
`-- --features boa`; the server runs the engine the module was built for.

## Layout

| Path                | Role                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/server.ts`     | The server module: pages, endpoints and the `greet` function                                                 |
| `src/client.ts`     | The browser entry, with `src/styles.css`                                                                     |
| `vite.config.ts`    | The fetchlet Vite plugin and Vite+ tasks                                                                     |
| `server/`           | `main.rs` starts `fetchlet_http::Server` with Rust routes and `/api/greet`; `services.rs` holds the bindings |
| `config.json`       | Listen address, body budgets, deadline, background budgets, message                                          |
| `tests/e2e.test.ts` | Checks over real HTTP in a real browser                                                                      |
| `build/`            | `server.js`, `client/`, `assets.flpk`, `fetchlet.json`                                                       |

The server reads the built script and style URLs of `src/client.ts` from
`virtual:fetchlet/client-assets`. `/api/greet?name=…` is an axum route that
calls the module's `greet` export with `AppHandle::call_json`.

## Checks

```bash
vp run setup:browser
vp run test:examples -- vanilla-axum
```

The shared checks (`tools/examples/common-checks.ts`) cover SSR and
escaping, the Rust service binding, assets, JSON endpoints, client address
and bindings, the axum route, body budgets, streaming uploads, `waitUntil`,
concurrent requests, the browser entry, document navigation and streaming.
Two more checks call `greet` from Rust and request an unknown path. Results
go to `results/example-vanilla-axum.json`. `tests/vite-dev.test.ts` runs the
`dev:vite` loop (`tools/examples/vite-dev-suite.ts`): it starts `vite dev` and the server with the `vite-dev`
feature, edits `src/server.ts` and `src/styles.css` in place and restores
them, and records `results/example-vanilla-axum-vite-dev.json`.
