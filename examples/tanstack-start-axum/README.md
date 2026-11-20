# TanStack Start + axum

Serves TanStack Start (React) streaming SSR, server functions and server
routes from axum.
[fetchlet/tanstack-start](../../packages/fetchlet/docs/tanstack-start.md)
builds the server into an artifact.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-tanstack-start-axum#serve
```

Open `http://127.0.0.1:3500`. The task builds, then starts the server on
QuickJS.

## Develop

```bash
vp run @fetchlet-internal/example-tanstack-start-axum#dev
```

The task keeps `vite build --watch` running and starts the server with the
`dev` feature once the first build is written. Vite rebuilds the client and
then the server after each change to a module they import; the server's
`DevReload` starts each new build and open pages reload. A failed build
leaves the previous one serving. Changes to `public/`, `vite.config.ts` or
the Rust sources need a restart.

## Develop from Vite

```bash
vp run @fetchlet-internal/example-tanstack-start-axum#dev:vite
```

The task runs `fetchlet dev --vite`, which starts `vite dev` on a free port, then the server with the
`vite-dev` feature, which runs Start's server entry from Vite on QuickJS. Open `http://127.0.0.1:3500`. A component
edit refreshes in the open page and renders on the next request; server
functions and routes run on the engine. The first request waits a few
seconds while Vite optimizes the server's dependencies.

## Layout

| Path                | Role                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `src/routes/`       | Routes and server routes (`server.handlers`)                                                |
| `src/context.ts`    | Registers the request context type                                                          |
| `vite.config.ts`    | TanStack Start, React and fetchlet Vite plugins, Vite+ tasks                                |
| `server/`           | `main.rs` starts `fetchlet_http::Server` with Rust routes; `services.rs` holds the bindings |
| `config.json`       | Listen address, body budgets, deadline, background budgets, message                         |
| `tests/e2e.test.ts` | Checks over real HTTP in a real browser                                                     |
| `build/`            | `server.js`, `client/`, `fetchlet.json`                                                     |

The loader of `/` calls `context.env.RUST` in a server function, so client
navigation also reaches the Rust binding through the server function.

The engine runs with `fetchlet_http::Server`'s default stacks, which the
[React Router example](../react-router-axum/README.md#stack) explains,
sized for the depth at which React's Fizz retries rendering after a stack
overflow.

## Checks

```bash
vp run setup:browser
vp run test:examples -- tanstack-start-axum
```

The shared ten checks (`tools/examples/common-checks.ts`) cover SSR and
escaping, the Rust service binding, assets, JSON endpoints, client address
and bindings, the axum route, body budgets, streaming uploads, `waitUntil`,
concurrent requests, hydration and navigation. Results go to
`results/example-tanstack-start-axum.json`. `tests/vite-dev.test.ts` runs
the `dev:vite` loop (`tools/examples/vite-dev-suite.ts`): SSR with a server
function calling Rust, server routes, hydration and navigation, and a
component edit refreshed in place, recorded in
`results/example-tanstack-start-axum-vite-dev.json` and its `-v8`
variant. It skips Boa, whose debug builds take minutes to evaluate Start's
development modules.
