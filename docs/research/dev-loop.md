# Research: a development loop with the Rust host

Today an example runs by building the JavaScript (`vp build`) and starting
the Rust program (`cargo run`); a source change needs both again. This note
compares ways for fetchlet to give framework apps an edit-and-reload loop
while the Rust host, its routes and its `HostServices` stay in place. Option A
is implemented for every axum and Tauri example, and option B for `fetchlet/vite`.

## Goal

A development loop for fetchlet keeps what makes the deployed program a
fetchlet program:

- Rust owns the process, the HTTP entry (or the Tauri URI scheme), its own
  routes and the services it grants.
- JavaScript runs on the engine the artifact targets, with the same Web API
  profile, `node:*` modules and authority boundary, including the trusted
  `Context` of [in-process fetch](../in-process-fetch.md).
- Browser assets keep Vite's client HMR.

When an app is deployed on Node and only wants Rust functions, napi-rs
already fits; this note is about apps whose deliverable is the Rust binary.

## Options

### A. Watch build and artifact reload

`vite build --watch` rewrites the artifact; the Rust program, through
fetchlet-http, notices the new `fetchlet.json` and `server.js`, starts an
`App` from them, swaps it in and shuts the old one down after its calls
drain. The page reloads through a small script injected in development.

- Runs exactly what a release build produces, with no framework-specific
  code in the Rust host.
- No server-side HMR; each change costs a server build and a new instance.

Option A is implemented. `fetchlet/build` writes `fetchlet.json` last
through a rename; `DevReload` in fetchlet-http (feature `dev`) polls its
modification time, builds a new generation of the caller's services and
links HTML responses to a long-poll reload script it serves under
`/__fetchlet/`
([fetchlet-http](../../crates/fetchlet-http/README.md#reloading-during-development)).
Every axum example has a `dev` task. The `fetchlet dev` command
([dev](../../packages/fetchlet/docs/dev.md)) watches the example's source
directories and runs its `build` task again when a file's
content changes, so files a build rewrites unchanged, such as generated
route tables, do not start another build. A full build is used rather than
each framework's watch mode: the Astro, Nuxt, React Router and Waku command
lines have none, HonoX and Qwik City build in two passes, and a full build
produces exactly the release artifact. Editing a component in each example
reloaded the server within 1.1 to 4.4 seconds, the build that followed
caused no further reload, and the page answered 200.

The Tauri examples serve through a URI scheme, whose responder takes whole
bodies, so their hosts take `DevReload::current()` for each request and
reload the window from Rust when `DevReload::reloads()` reports a new
generation, instead of the script `DevService` injects. honox-tauri's `dev`
task showed an edited route in the open window 1.5 seconds after the save,
and sveltekit-axum-tauri's `dev:desktop` 3.8 seconds after it, most of it
the SvelteKit build; `dev:serve` serves the same builds to browsers through
`DevService`.

With `vite build --watch`, each environment rebuilds on its own, so a client
change can leave a server that embeds the old client URLs. The `fetchlet/vite`
server build watches the client manifest to avoid that; SvelteKit 3.4.0
rewrote the artifact when a page changed; the other integrations are
unverified under `--watch`.

### B. Vite's module runner on the fetchlet engine

The approach the Cloudflare Vite plugin takes with workerd. In development
the Rust program connects to a Vite dev server instead of opening an
artifact:

- The engine evaluates a bootstrap module: the profile's polyfills for that
  engine and `vite/module-runner`. The runner evaluates transformed modules
  with `AsyncFunction`, so the engine needs no ES module loader of its own;
  it fetches modules from Vite through a transport over outbound fetch to an
  endpoint the fetchlet Vite plugin installs.
- Rust stays the front door: requests for SSR and Rust routes are handled as
  in production, the rest are proxied to Vite, and the browser connects to
  Vite's HMR port directly. In-process fetch, `Context` and a Tauri scheme
  behave as they do in production.
- The fetchlet Vite plugin configures the server environment as a
  non-runnable environment (no runner in Node), resolves `node:*` to
  `@fetchlet/node` and selects polyfills as `fetchlet/build` does.
- fetchlet has no WebSocket, so file changes reach the runner through a
  long-poll; the runner clears its evaluated modules, or Rust replaces the
  instance.

This gives Vite's loop with production's engine and authority, but depends
on how each framework evaluates its server in development (below).

Option B is implemented for `fetchlet/vite`
([development serving](../../packages/fetchlet/docs/vite.md#development-serving)),
with fetchlet-http's `ViteDev` (feature `vite-dev`) on the Rust side and a
`dev:vite` task in examples/vanilla-axum. It differs from the outline above
in three places:

- The plugin keeps Vite's default `ssr` environment and answers the runner's
  `invoke` calls with `environment.hot.handleInvoke`; nothing configures the
  environment as non-runnable, since no framework code asks for its runner.
- File changes reach the runner without a long-poll: before each call it asks
  the plugin for the server modules changed since its last call, which the
  plugin records from `hotUpdate` with their importers, and invalidates
  them. A change also sends the browser a full reload.
- The runner reaches Vite through a host service binding, `FETCHLET_VITE`,
  whose transport forwards to the dev server, rather than through a policy
  that allows Vite's origin. The application's services and policies are
  unchanged.

On vanilla-axum, the module runner ran on QuickJS, Boa and V8 with the
profile's polyfills. `tests/vite-dev.test.ts` checks it on each engine:
pages, a named export and hydration from Vite's modules, a server edit
served on the next request and reloading an open page, and a stylesheet
edit applied in the open page without a reload. By hand, a server edit was
served 16 to 22 ms after it was saved on QuickJS and 150 to 170 ms on Boa
(debug builds).

TanStack Start runs the same way through `fetchlet/tanstack-start`. Start's
dev plugin leaves requests alone when the `ssr` environment has
`dispatchFetch`, and the runner imports `virtual:tanstack-start-server-entry`
in the engine. Start's development modules needed more than vanilla:

- Its dependencies resolve with the `development` condition and
  `NODE_ENV=development`, since React's development JSX runtime is what
  Start's development transforms emit.
- The server environment prebundles CommonJS dependencies, including
  `react-dom/server.edge`, and takes the client environment's
  `optimizeDeps` exclusions, which keep Start's server function resolver out
  of the prebundle.
- Evaluated modules see `process`, `Buffer`, `setImmediate` and
  `clearImmediate` from the artifact's Node profile as free variables.
- When Vite re-optimizes dependencies, the runner clears its cache and loads
  the entry again.

`examples/tanstack-start-axum/tests/vite-dev.test.ts` checks it on QuickJS
and V8: server rendering with a server function calling the Rust service,
API routes, hydration and client navigation, and a component edit applied
by React Fast Refresh without losing state and rendered by the next request.
On V8 the suite first stalled on a page request: the pooled connection to
Vite was a task on another isolate thread's runtime, which ran only during a
call. V8 calls now run host futures on the caller's runtime. Debug builds of
Boa take minutes to evaluate Start's development modules, so the suite skips
Boa; built Start artifacts run on Boa in the example's main suite.

SolidStart needed nothing beyond that: `fetchlet/solid-start` passes
`solid-start:server-entry` and the request properties its artifact entry
sets. Its development styles come from Vite's `/@manifest` modules through
the runner. `examples/solidstart-axum/tests/vite-dev.test.ts` runs the same
four checks; Solid's hot module replacement remounts the edited component,
so its signals start over while the page stays loaded. On Boa, the page
first failed to hydrate: functions made by Boa's `Function` constructor have
no source text, and seroval writes the resolvers of streamed data into the
page by their source. The runner now evaluates each module through indirect
`eval`, whose functions keep it.

React Router decides by `isRunnableDevEnvironment` rather than
`dispatchFetch`, so `fetchletDevServer` replaces its `ssr` environment
with a plain `DevEnvironment` over a server hot channel, which still
answers the engine's runner through `handleInvoke`. Its entry is a virtual
module that creates React Router's request handler over
`virtual:react-router/server-build` with the preset's load context. React
Router does not mark its dependencies `noExternal`, so the dev server plugin
now keeps every module of the server environment internal: the engine
loads nothing Vite does not transform. Critical CSS stays Vite's: the page
links `/@react-router/critical.css`, which the proxy passes to Vite.
`examples/react-router-axum/tests/vite-dev.test.ts` runs the same four
checks, with React Fast Refresh keeping state.

On Boa, the runner can spend longer than Node's 5-second keep-alive timeout
evaluating one large module, such as the prebundled `react-dom/server.edge`,
between two requests to Vite. Its next request then went out on a pooled
connection Node had just closed and failed with `ConnectionAborted`;
`ViteDev` now gives up idle connections after 2 seconds.

A rarer stall had the same shape as V8's: a pooled connection to Vite is a
task on the runtime of the worker that opened it, and a QuickJS worker's
runtime stops while its engine evaluates. A page request on another worker
that reused the connection waited, and about one TanStack Start run in four
timed out. `ViteDev` now sends the runner's requests on the server's
runtime; six runs in a row passed.

### C. JavaScript in Node, Rust services bridged

The framework's own dev server runs the server code in Node; the Rust
program only serves its routes and services, and the fetchlet runtime in
Node forwards in-process fetch and service calls to it over HTTP or napi.
This is the direction [open work](../TODO.md) currently describes for
vanilla development serving.

- Every framework's dev server works unchanged, with full HMR.
- The engine and the authority boundary differ from production: Node code
  can reach anything, and a `Context` crossing a socket is no longer
  unforgeable. It is the napi-rs model with extra steps.

## How frameworks evaluate their server in development

Read from the installed packages. "Runnable" means the framework imports its
server through `environment.runner` inside the Vite process, which option B
cannot replace; "fetchable" means it hands requests to
`environment.dispatchFetch`, which a custom environment can implement.

| Framework (version)              | Server environment in development                                                            | Option B                 |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| TanStack Start (1.169)           | Fetchable when the environment is not runnable                                               | Runs                     |
| SolidStart (2.2.3)               | Fetchable when the environment is not runnable                                               | Runs                     |
| React Router (8.5.2)             | Skips its middleware when not runnable, leaving requests to another one                      | Runs                     |
| Astro (7.4.13)                   | Falls back to its `astro` environment for content when `ssr` is not runnable, as for workerd | Likely                   |
| vinext (1.4.6)                   | `createServerModuleRunner`, `ssrLoadModule` and `runner.import`                              | To investigate           |
| SvelteKit (3.4.0)                | Requires a runnable `ssr` environment and errors otherwise                                   | Not without Kit changes  |
| Waku (1.0.0-rc.5)                | Imports its entry through `environments.rsc.runner`                                          | Not without Waku changes |
| Nuxt 4.6.4 / Nitro 2.13.6        | Nitro's own Node dev server                                                                  | No                       |
| Qwik City (1.20), HonoX (0.1.62) | `ssrLoadModule` in Node                                                                      | No                       |
| Vanilla (`fetchlet/vite`)        | fetchlet's own plugin decides                                                                | Runs                     |

The checks were for `isRunnableDevEnvironment`, `isFetchableDevEnvironment`,
`dispatchFetch`, `runner.import`, `createServerModuleRunner` and
`ssrLoadModule` in each package's distributed sources, then reading the
branches around them. "Runs" means an example's `dev:vite` suite passes;
the other frameworks' dev servers are unverified on a fetchlet environment.

## Direction

1. Option A as the baseline for every framework. It is cheap, matches
   release builds exactly, and remains the fallback where option B cannot
   apply. Extending it to each example is in [open work](../TODO.md#development-reload-per-framework).
2. Option B as fetchlet's own development server, starting with vanilla
   `fetchlet/vite`, where fetchlet writes the entry, then TanStack Start,
   SolidStart and React Router. That replaces the Node module runner plan in
   the vanilla item of [open work](../TODO.md).
3. Option C not pursued; frameworks that require a runnable environment use
   option A.

## Open questions

- How do source maps and stack traces from runner-evaluated code reach the
  Rust log?
- How does a release build guarantee the `vite-dev` and `dev` features are
  absent? Today it is the application's Cargo features.
- Does Astro serve content from its `astro` environment, with `ssr` left to
  the engine's runner?
