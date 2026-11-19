# Vanilla JavaScript + axum

Serves a server module without a framework from axum. The module's default
export handles requests with `fetch(request, env, ctx)`, as a Cloudflare
Workers module does, and renders HTML that loads one browser entry. Its
named export `greet` is called directly from a Rust route.
[fetchlet/vite](../../packages/fetchlet/docs/vite.md) builds both into an
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

The task builds once and starts the server with the `dev` feature. Whenever
a file in `src/`, `public/` or `vite.config.ts` changes, it runs the `build`
task again; the server's `DevReload` starts each new build and open pages
reload. A failed build leaves the previous one serving. Changes to the Rust
sources need a restart.

## Layout

| Path                | Role                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `src/server.ts`     | The server module: pages, endpoints and the `greet` function              |
| `src/client.ts`     | The browser entry, with `src/styles.css`                                  |
| `vite.config.ts`    | The fetchlet Vite plugin and Vite+ tasks                                  |
| `server/`           | Starting axum, bindings, routing, the `/api/greet` route                  |
| `config.json`       | Listen address, queue, body budgets, deadline, background budgets, stacks |
| `tests/e2e.test.ts` | Checks over real HTTP in a real browser                                   |
| `build/`            | `server.js`, `client/`, `assets.flpk`, `fetchlet.json`                    |

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
go to `results/example-vanilla-axum.json`.
