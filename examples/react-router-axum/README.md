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

## Layout

| Path                     | Role                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `app/`                   | Routes, components, `entry.server.tsx`, typed load context                |
| `react-router.config.ts` | React Router configuration and the fetchlet preset                        |
| `vite.config.ts`         | React Router's Vite plugin, Vite+ tasks                                   |
| `src/`                   | Starting axum, bindings, routing                                          |
| `config.json`            | Listen address, queue, body budgets, deadline, background budgets, stacks |
| `tests/e2e.test.ts`      | Checks over real HTTP in a real browser                                   |
| `build/`                 | `server.js`, `client/`, `fetchlet.json` (`server/` is intermediate)       |

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

`quickjs_stack_bytes` (4 MiB) and `worker_stack_bytes` (8 MiB) in
`config.json` fit React's recursion depth. With QuickJS's default 1 MiB, Rust
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
