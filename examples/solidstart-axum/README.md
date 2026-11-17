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

## Layout

| Path                   | Role                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `src/routes/`          | Pages, API routes, the 404 route                                          |
| `src/lib/completed.ts` | State shared between API route handlers                                   |
| `vite.config.ts`       | SolidStart and fetchlet Vite plugins, Vite+ tasks                         |
| `src/`                 | Starting axum, bindings, routing                                          |
| `config.json`          | Listen address, queue, body budgets, deadline, background budgets, stacks |
| `tests/e2e.ts`         | Checks over real HTTP in a real browser                                   |
| `build/`               | `server.js`, `client/`, `fetchlet.json`                                   |

SolidStart builds each API route handler as its own module, so the state of
`/api/background` lives in `src/lib/`. `[...404].tsx` answers unmatched paths
with 404.

`quickjs_stack_bytes` (4 MiB) and `worker_stack_bytes` (8 MiB) in
`config.json` match the [React Router example](../react-router-axum/README.md#stack);
the minimum this framework needs has not been measured.

## Checks

```bash
vp run setup:browser
vp run test:examples -- solidstart-axum
```

The shared ten checks (`tools/examples/common-checks.ts`) cover SSR and
escaping, the Rust service binding, assets, JSON endpoints, client address
and bindings, the axum route, body budgets, streaming uploads, `waitUntil`,
concurrent requests, hydration and navigation. Results go to
`results/example-solidstart-axum.json`.
