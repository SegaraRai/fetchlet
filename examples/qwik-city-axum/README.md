# Qwik City + axum

Serves Qwik City's resumable SSR, `routeLoader$` and endpoints from axum.
[fetchlet/qwik-city](../../packages/fetchlet/docs/qwik-city.md) builds the
server into an artifact.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-qwik-city-axum#serve
```

Open `http://127.0.0.1:3700`. The task runs the client build and the SSR
build (`vp build --ssr`), then starts the server on QuickJS.

## Develop

```bash
vp run @fetchlet-internal/example-qwik-city-axum#dev
```

The task builds once and starts the server with the `dev` feature. Whenever
a file in `src/`, `public/` or `vite.config.ts` changes, it runs the `build`
task again; the server's `DevReload` starts each new build and open pages
reload. A failed build leaves the previous one serving. Changes to the Rust
sources need a restart.

## Layout

| Path                     | Role                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `src/routes/`            | Pages, layouts, endpoints (`onGet`, `onPost`)                                               |
| `src/entry.fetchlet.tsx` | fetchlet's server entry                                                                     |
| `vite.config.ts`         | Qwik, Qwik City and fetchlet Vite plugins, Vite+ tasks                                      |
| `server/`                | `main.rs` starts `fetchlet_http::Server` with Rust routes; `services.rs` holds the bindings |
| `config.json`            | Listen address, body budgets, deadline, background budgets, message                         |
| `tests/e2e.test.ts`      | Checks over real HTTP in a real browser                                                     |
| `build/`                 | `server.js`, `client/`, `fetchlet.json`                                                     |

Qwik resumes instead of hydrating; the counter's `data-hydrated` is set by
`useVisibleTask$`. Qwik inlines component styles and loads chunks from
`/build/`.

The engine runs with `fetchlet_http::Server`'s default stacks, which the
[React Router example](../react-router-axum/README.md#stack) explains; the minimum this
framework needs has not been measured.

## Checks

```bash
vp run setup:browser
vp run test:examples -- qwik-city-axum
```

The shared ten checks (`tools/examples/common-checks.ts`) cover SSR and
escaping, the Rust service binding, assets, JSON endpoints, client address
and bindings, the axum route, body budgets, streaming uploads, `waitUntil`,
concurrent requests, hydration and navigation. Results go to
`results/example-qwik-city-axum.json`.
