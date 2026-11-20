# SolidStart + axum

Serves SolidStart 2's streaming SSR, `query` server functions and API routes
from axum. [fetchlet/solid-start](../../packages/fetchlet/docs/solid-start.md)
builds the server into an artifact.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-solidstart-axum#serve
```

Open `http://127.0.0.1:3600`. The task builds, then starts the server on
QuickJS.

## Develop

```bash
vp run @fetchlet-internal/example-solidstart-axum#dev
```

The task keeps `vite build --watch` running and starts the server with the
`dev` feature once the first build is written. Vite rebuilds the client and
then the server after each change to a module they import; the server's
`DevReload` starts each new build and open pages reload. A failed build
leaves the previous one serving. Changes to `public/`, `vite.config.ts` or
the Rust sources need a restart.

## Develop from Vite

```bash
vp run @fetchlet-internal/example-solidstart-axum#dev:vite
```

The task runs `fetchlet dev --vite`, which starts `vite dev` on a free port, then the server with the
`vite-dev` feature, which runs SolidStart's server entry from Vite on
QuickJS. Open `http://127.0.0.1:3600`. A
component edit is replaced in the open page by Solid's hot module
replacement, which remounts the component, and renders on the next request;
server functions and API routes run on the engine.

## Layout

| Path                     | Role                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `src/routes/`            | Pages, API routes, the 404 route                                                            |
| `src/lib/completed.ts`   | State shared between API route handlers                                                     |
| `vite.config.ts`         | SolidStart and fetchlet Vite plugins, Vite+ tasks                                           |
| `server/`                | `main.rs` starts `fetchlet_http::Server` with Rust routes; `services.rs` holds the bindings |
| `config.json`            | Listen address, body budgets, deadline, background budgets, message                         |
| `tests/e2e.test.ts`      | Checks over real HTTP in a real browser                                                     |
| `tests/vite-dev.test.ts` | The `dev:vite` loop with in-place edits                                                     |
| `build/`                 | `server.js`, `client/`, `fetchlet.json`                                                     |

SolidStart builds each API route handler as its own module, so the state of
`/api/background` lives in `src/lib/`. `[...404].tsx` answers unmatched paths
with 404.

The engine runs with `fetchlet_http::Server`'s default stacks, which the
[React Router example](../react-router-axum/README.md#stack) explains; the minimum this
framework needs has not been measured.

## Checks

```bash
vp run setup:browser
vp run test:examples -- solidstart-axum
```

The shared ten checks (`tools/examples/common-checks.ts`) cover SSR and
escaping, the Rust service binding, assets, JSON endpoints, client address
and bindings, the axum route, body budgets, streaming uploads, `waitUntil`,
concurrent requests, hydration and navigation. Results go to
`results/example-solidstart-axum.json`. `tests/vite-dev.test.ts` runs the
`dev:vite` loop (`tools/examples/vite-dev-suite.ts`): SSR with a server
function calling Rust and Vite's development styles, API routes, hydration
and navigation, and a component edit replaced in the open page, recorded in
`results/example-solidstart-axum-vite-dev.json` and its engine variants.
