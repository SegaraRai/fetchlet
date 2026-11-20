# React Router + axum

React Router in framework mode renders HTML and resource routes, served by
axum. [fetchlet/react-router](../../packages/fetchlet/docs/react-router.md)
builds the server into an artifact. Try React component hydration, `Form`,
deferred data and client navigation.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-react-router-axum#serve
```

Open `http://127.0.0.1:3300`. The task builds React Router and starts the
server on QuickJS.

## Develop

```bash
vp run @fetchlet-internal/example-react-router-axum#dev
```

The task builds once and starts the server with the `dev` feature. Whenever
a file in `app/`, `public/`, `react-router.config.ts` or `vite.config.ts`
changes, it runs the `build` task again; the server's `DevReload` starts
each new build and open pages reload. A failed build leaves the previous one
serving. Changes to the Rust sources need a restart.

## Develop from Vite

```bash
vp run @fetchlet-internal/example-react-router-axum#dev:vite
```

The task runs `fetchlet dev --vite`, which starts `vite dev` on a free port, then the server with the
`vite-dev` feature, which runs React Router's server build from Vite on
QuickJS. Open `http://127.0.0.1:3300`. A
component edit refreshes in the open page and renders on the next request;
loaders, actions and resource routes run on the engine.

## Layout

| Path                     | Role                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `app/`                   | Routes, components, `entry.server.tsx`, typed load context                                  |
| `react-router.config.ts` | React Router configuration and the fetchlet preset                                          |
| `vite.config.ts`         | React Router's Vite plugin, Vite+ tasks                                                     |
| `src/`                   | `main.rs` starts `fetchlet_http::Server` with Rust routes; `services.rs` holds the bindings |
| `config.json`            | Listen address, body budgets, deadline, background budgets, message                         |
| `tests/e2e.test.ts`      | Checks over real HTTP in a real browser                                                     |
| `tests/vite-dev.test.ts` | The `dev:vite` loop with in-place edits                                                     |
| `build/`                 | `server.js`, `client/`, `fetchlet.json` (`server/` is intermediate)                         |

## Routes and context

| Route             | Behavior                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `/`               | The loader calls `env.RUST`; the action sets a cookie                                         |
| `/deferred`       | Shows a loader promise with `<Await>`, sending the value after the shell in the same response |
| `/api/echo`       | A resource route that returns JSON with 201                                                   |
| `/api/context`    | Returns `clientAddress` and `env.MESSAGE`                                                     |
| `/api/upload`     | Counts the arriving body; declared excess is 413, undeclared excess `LIMIT_EXCEEDED`          |
| `/api/background` | Registers work after the response with `waitUntil`                                            |

`app/context.ts` reads the values with `getLoadContext<Bindings>(context)`.
`app/entry.server.tsx` renders with `renderToReadableStream` from
`react-dom/server.edge`; crawlers receive the response after rendering
completes.

## Stack

`fetchlet_http::Server` gives QuickJS a 4 MiB stack limit within a 64 MiB
worker thread by default, which fits React's recursion depth. With QuickJS's default 1 MiB, Rust
debug builds made React retry rendering after a stack overflow, leaving a
`<link` fragment in the head (2 MiB is enough; release builds do not hit it
at 1 MiB). The worker thread's stack must be larger than QuickJS's limit.
The [preset](../../packages/fetchlet/docs/react-router.md#rendering-and-the-quickjs-stack)
has the details.

## Checks

```bash
vp run setup:browser
vp run test:examples -- react-router-axum
```

The checks cover SSR and escaping, the integrity of hoisted links, assets,
streaming of deferred data, resource routes, document actions and cookies,
the load context, the axum route, body budgets, streaming uploads,
`waitUntil`, concurrent requests, hydration, and client actions and
navigation. Results go to `results/example-react-router-axum.json`.
`tests/vite-dev.test.ts` runs the `dev:vite` loop
(`tools/examples/vite-dev-suite.ts`): SSR with a loader calling Rust and
critical CSS from Vite, resource routes, hydration and navigation, and a
component edit refreshed in place, recorded in
`results/example-react-router-axum-vite-dev.json` and its engine variants.
