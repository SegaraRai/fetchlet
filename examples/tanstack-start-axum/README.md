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

The task builds once and starts the server with the `dev` feature. Whenever
a file in `src/`, `public/` or `vite.config.ts` changes, it runs the `build`
task again; the server's `DevReload` starts each new build and open pages
reload. A failed build leaves the previous one serving. Changes to the Rust
sources need a restart.

## Layout

| Path                | Role                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `src/routes/`       | Routes and server routes (`server.handlers`)                              |
| `src/context.ts`    | Registers the request context type                                        |
| `vite.config.ts`    | TanStack Start, React and fetchlet Vite plugins, Vite+ tasks              |
| `server/`           | Starting axum, bindings, routing                                          |
| `config.json`       | Listen address, queue, body budgets, deadline, background budgets, stacks |
| `tests/e2e.test.ts` | Checks over real HTTP in a real browser                                   |
| `build/`            | `server.js`, `client/`, `fetchlet.json`                                   |

The loader of `/` calls `context.env.RUST` in a server function, so client
navigation also reaches the Rust binding through the server function.

`quickjs_stack_bytes` (4 MiB) and `worker_stack_bytes` (8 MiB) in
`config.json` match the [React Router example](../react-router-axum/README.md#stack),
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
`results/example-tanstack-start-axum.json`.
