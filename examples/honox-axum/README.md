# HonoX + axum

Serves HonoX's file-based routes and islands from axum.
[fetchlet/hono](../../packages/fetchlet/docs/hono.md) builds the server into
an artifact.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-honox-axum#serve
```

Open `http://127.0.0.1:3400`. The task builds twice, the client
(`--mode client`) and the server, then starts the server on QuickJS.

## Develop

```bash
vp run @fetchlet-internal/example-honox-axum#dev
```

The task builds once and starts the server with the `dev` feature. Whenever
a file in `app/`, `public/` or `vite.config.ts` changes, it runs the `build`
task again; the server's `DevReload` starts each new build and open pages
reload. A failed build leaves the previous one serving. Changes to the Rust
sources need a restart.

## Layout

| Path                | Role                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `app/`              | Routes, islands, renderer, API routes                                                       |
| `vite.config.ts`    | HonoX and fetchlet Vite plugins, Vite+ tasks                                                |
| `src/`              | `main.rs` starts `fetchlet_http::Server` with Rust routes; `services.rs` holds the bindings |
| `config.json`       | Listen address, body budgets, deadline, background budgets, message                         |
| `tests/e2e.test.ts` | Checks over real HTTP in a real browser                                                     |
| `build/`            | `server.js`, `client/`, `fetchlet.json`                                                     |

HonoX islands have no client router, so navigating to `/about` loads a new
document. Assets are served from `/static/`.

The engine runs with `fetchlet_http::Server`'s default stacks, which the
[React Router example](../react-router-axum/README.md#stack) explains; the minimum this
framework needs has not been measured.

## Checks

```bash
vp run setup:browser
vp run test:examples -- honox-axum
```

The shared ten checks (`tools/examples/common-checks.ts`) cover SSR and
escaping, the Rust service binding, assets, JSON endpoints, client address
and bindings, the axum route, body budgets, streaming uploads, `waitUntil`,
concurrent requests, hydration and navigation. Results go to
`results/example-honox-axum.json`.
