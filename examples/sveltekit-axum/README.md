# SvelteKit + axum

SvelteKit renders the HTML and axum serves HTTP, JavaScript and CSS. Try the
counter and the form in a browser, and navigate between pages on the
client.

## Run

From the repository root:

```bash
vp install --frozen-lockfile
vp run @fetchlet-internal/example-sveltekit-axum#serve
```

Open `http://127.0.0.1:3000`. The task builds SvelteKit and starts the Rust
server; stop it with Ctrl+C.

## Develop

```bash
vp run @fetchlet-internal/example-sveltekit-axum#dev
```

The task builds once and starts the server with the `dev` feature. Whenever
a file in `web/` or `vite.config.ts` changes, it runs the `build` task
again; the server's `DevReload` starts each new build and open pages reload.
A failed build leaves the previous one serving. Changes to the Rust sources
need a restart.

## Layout

| Path                | Role                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `web/`              | SvelteKit pages, actions, endpoints and public files                |
| `vite.config.ts`    | Build settings for SvelteKit and the fetchlet adapter               |
| `src/`              | axum routing, the shared handle and HTTP integration, Rust services |
| `config.json`       | Listen address, queue, body budgets, deadlines, env                 |
| `tests/e2e.test.ts` | Checks over real HTTP in a real browser                             |
| `build/`            | Output: `server.js`, `client/`, `fetchlet.json`                     |

One server handles Rust's `/api/rust` and SvelteKit's routes. Static files
are served first and dynamic requests go to JavaScript, including POST and
other methods.

## Bindings and context

Rust passes `MESSAGE` and the `RUST` service as fixed bindings. The adapter
connects them to SvelteKit's `platform.env` and passes string bindings to
the server's initialization env. The page's load fetches a greeting from the
Rust service.

The client IP travels in the context argument of `App::fetch_with_context`,
which the adapter connects to `getClientAddress()`; no request data is
written to shared globals.

## In-process Rust API

`api_router` in `src/services.rs` defines the Rust API as one axum router.

- The server mounts it at `/api/v1` for browsers.
- `OriginRouter::internal("https://fetchlet.internal", router_transport(...))`
  registers the same router in-process and passes it to both the `RUST`
  binding and global `fetch`. The policy allows only that origin.
- Calls from JavaScript reach the router without a socket and share the
  Rust application's state.
- `FetchletService::trusted_context` builds a `Caller` from the client IP
  and passes it to the SSR invocation as a `fetchlet::Context`. The
  `/caller` handler uses only that Context, never headers.

| Route                      | Behavior                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `/projects`                | load lists projects with `event.fetch`; the action adds one with `RUST.fetch`; an empty name is 400 |
| `/api/projects/[id]`       | Returns the Rust API's response as it is; an unknown id is 404                                      |
| `/api/in-process/failure`  | A 500 from the Rust handler arrives as a Response                                                   |
| `/api/in-process/caller`   | Returns the Context's client address (127.0.0.1) even with `x-forwarded-for` set                    |
| `/api/in-process/denied`   | An unregistered origin is `PERMISSION_DENIED` through the binding, global `fetch` and `event.fetch` |
| `/api/in-process/abort`    | Aborts after 50 ms; the next call in the same invocation confirms the Rust handler was dropped      |
| `/api/in-process/internal` | A same-origin `event.fetch` is handled by SvelteKit in JavaScript, without the Rust API             |
| `/api/v1/*`                | The same router over public HTTP; `/api/v1/caller` has no Context and answers 401                   |
| `/api/v1/stats`            | The Rust API's call and cancel counts, the same as in-process `/stats`                              |

HTTP errors arrive in JavaScript as responses; permission denials,
cancellations and transport errors as rejections.

## Work after the response

`/api/background` registers work with `platform.context.waitUntil`; the
worker finishes it before the next request. The budgets are
`background_timeout_ms` (5 seconds) and `background_tasks` (8) in
`config.json`.

## Configuration

`config.json` holds this local example's operating choices: a queue of 8, a
1 MiB request body and a 10-second cooperative deadline, sized for small
pages and forms. Change them for other uses; `null` body and deadline values
leave those budgets to the host.

`AppHandle` owns the thread, queue, cancellation and instance rebuilding,
and `FetchletService` connects axum's bodies and context. The example uses
only public APIs.

To use another configuration, pass its path to the server after building:

```bash
node tools/workspace/cargo.ts run --locked -p example-sveltekit-axum -- path/to/config.json
```

`build_directory` is relative to the configuration file or absolute.
`public_origin` sets the public origin outside a proxy for requests; it
defaults to the actual listen address.

Cookies are set for local HTTP; set the action's cookie to `secure` behind
HTTPS. This example uses Svelte's synchronous rendering; asynchronous
actions are covered by the checks.

## End-to-end checks

```bash
vp run setup:browser
vp run test:examples -- sveltekit-axum
```

Set `FETCHLET_BROWSER_CHANNEL=chrome` to use an installed Chrome.

The checks cover SSR and escaping, JavaScript, CSS and static files, JSON
endpoints, form actions and `Set-Cookie`, the client address and env, the
Rust route, body budgets, work after the response, the in-process Rust API
(shared with public HTTP, HTTP errors, trusted Context, origin policy,
cancellation, the `event.fetch` split), concurrent requests, hydration and
form submission, and client navigation. Results go to
`results/example-sveltekit-axum.json`.

The adapter uses the [SvelteKit adapter API](https://svelte.dev/docs/kit/writing-adapters);
HTTP and static serving use [axum](https://docs.rs/axum/0.8.9/axum/) and
fetchlet-http's `artifact_router`.
