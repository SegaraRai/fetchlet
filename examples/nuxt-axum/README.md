# Nuxt + axum

Nuxt renders HTML and server routes, served by axum.
[fetchlet/nitro](https://fetchlet.roundtrip.dev/docs/frameworks/nitro) builds Nuxt's Nitro
server. Try Vue component hydration, the form and client navigation.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-nuxt-axum#serve
```

Open `http://127.0.0.1:3200`. The task builds Nuxt and starts the Rust
server on QuickJS.

## Develop

```bash
vp run @fetchlet-internal/example-nuxt-axum#dev
```

The task builds once and starts the server with the `dev` feature. Whenever
a file in `web/` or `nuxt.config.ts` changes, it runs the `build` task
again; the server's `DevReload` starts each new build and open pages reload.
A failed build leaves the previous one serving. Changes to the Rust sources
need a restart.

## Layout

| Path                | Role                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `web/`              | Nuxt pages, components, server routes and public files                                      |
| `nuxt.config.ts`    | `srcDir` and `serverDir`, runtime config, the Nitro preset                                  |
| `vite.config.ts`    | Vite+ tasks                                                                                 |
| `src/`              | `main.rs` starts `fetchlet_http::Server` with Rust routes; `services.rs` holds the bindings |
| `config.json`       | Listen address, body budgets, deadline, background budgets, message                         |
| `tests/e2e.test.ts` | Checks over real HTTP in a real browser                                                     |
| `build/`            | Output: `server.js`, `client/`, `fetchlet.json`                                             |

axum handles the static files in `build/client` and `/api/rust` first, and
passes the rest to Nuxt through `FetchletService`.

## Bindings and context

- Rust passes `NUXT_MESSAGE` and the `RUST` service as fixed bindings.
  `NUXT_MESSAGE` overrides Nuxt's runtime config `message`.
- `/api/greeting` uses the runtime config and
  `event.context.fetchlet.env.RUST`. The page calls it with `useFetch`, and
  the binding carries over into the Nitro-internal call.
- `/api/context` returns the client address from `getRequestIP(event)`.
- `/greet` sets a cookie from a form POST and redirects back with 303.
- `/api/upload` counts the arriving body with `getRequestWebStream(event)`.
  A body whose `Content-Length` declares more than the budget is refused
  with 413 before execution; undeclared excess errors the stream
  (`LIMIT_EXCEEDED`).
- `/api/background` registers work after the response with
  `event.waitUntil`.

## Checks

```bash
vp run setup:browser
vp run test:examples -- nuxt-axum
```

The checks cover SSR and escaping, runtime config, the Rust service, assets,
JSON routes, forms and cookies, client address and bindings, the axum route,
body budgets, streaming uploads, `event.waitUntil`, concurrent requests,
hydration and client navigation. Results go to
`results/example-nuxt-axum.json`.
