# vinext + axum

Serves the App Router, React Server Components and route handlers of vinext,
an implementation of the Next.js API on Vite, from axum.
[fetchlet/vinext](../../packages/fetchlet/docs/vinext.md) builds the server
into an artifact.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-vinext-axum#serve
```

Open `http://127.0.0.1:3900`. The task builds, then starts the server on
QuickJS.

## Layout

| Path                | Role                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `app/`              | Layouts, pages, route handlers                                            |
| `vite.config.ts`    | vinext and fetchlet Vite plugins, Vite+ tasks                             |
| `src/`              | Starting axum, bindings, routing                                          |
| `config.json`       | Listen address, queue, body budgets, deadline, background budgets, stacks |
| `tests/e2e.test.ts` | Checks over real HTTP in a real browser                                   |
| `build/`            | `server.js`, `client/`, `fetchlet.json`                                   |

`/api/background` registers work after the response with `after()` from
`next/server`. `background_tasks` in `config.json` is 64: on the first
request vinext registers a `waitUntil` for each route module preload, and
with 8 the first page failed to render over budget.

`quickjs_stack_bytes` (4 MiB) and `worker_stack_bytes` (8 MiB) in
`config.json` match the [React Router example](../react-router-axum/README.md#stack),
sized for the depth at which React's Fizz retries rendering after a stack
overflow.

## Checks

```bash
vp run setup:browser
vp run test:examples -- vinext-axum
```

The shared ten checks (`tools/examples/common-checks.ts`) cover SSR and
escaping, the Rust service binding, assets, JSON endpoints, client address
and bindings, the axum route, body budgets, streaming uploads, `waitUntil`,
concurrent requests, hydration and navigation. Results go to
`results/example-vinext-axum.json`.
