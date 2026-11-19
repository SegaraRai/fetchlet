# Research: a development loop with the Rust host

Today an example runs by building the JavaScript (`vp build`) and starting
the Rust program (`cargo run`); a source change needs both again. This note
compares ways for fetchlet to give framework apps an edit-and-reload loop
while the Rust host, its routes and its `HostServices` stay in place. Option A
is implemented for every axum example, and option B for `fetchlet/vite`.

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
Every axum example has a `dev` task. `tools/examples/dev.ts` watches the
example's source directories and runs its `build` task again when a file's
content changes, so files a build rewrites unchanged, such as generated
route tables, do not start another build. A full build is used rather than
each framework's watch mode: the Astro, Nuxt, React Router and Waku command
lines have none, HonoX and Qwik City build in two passes, and a full build
produces exactly the release artifact. Editing a component in each example
reloaded the server within 1.1 to 4.4 seconds, the build that followed
caused no further reload, and the page answered 200.

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

On vanilla-axum, the module runner ran on QuickJS and Boa with the
profile's polyfills; a server edit was served on the next request (16 to
22 ms on QuickJS, 150 to 170 ms on Boa, debug builds), a stylesheet edit was
applied in the open page without a reload, and a server edit reloaded it.

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
| TanStack Start (1.169)           | Fetchable when the environment is not runnable                                               | Fits                     |
| SolidStart (2.2.3)               | Fetchable when the environment is not runnable                                               | Fits                     |
| React Router (8.5.2)             | Skips its middleware when not runnable, leaving requests to another one                      | Fits                     |
| Astro (7.4.13)                   | Falls back to its `astro` environment for content when `ssr` is not runnable, as for workerd | Likely                   |
| vinext (1.4.6)                   | `createServerModuleRunner`, `ssrLoadModule` and `runner.import`                              | To investigate           |
| SvelteKit (3.4.0)                | Requires a runnable `ssr` environment and errors otherwise                                   | Not without Kit changes  |
| Waku (1.0.0-rc.5)                | Imports its entry through `environments.rsc.runner`                                          | Not without Waku changes |
| Nuxt 4.6.4 / Nitro 2.13.6        | Nitro's own Node dev server                                                                  | No                       |
| Qwik City (1.20), HonoX (0.1.62) | `ssrLoadModule` in Node                                                                      | No                       |
| Vanilla (`fetchlet/vite`)        | fetchlet's own plugin decides                                                                | Fits                     |

The checks were for `isRunnableDevEnvironment`, `isFetchableDevEnvironment`,
`dispatchFetch`, `runner.import`, `createServerModuleRunner` and
`ssrLoadModule` in each package's distributed sources, then reading the
branches around them. Whether each framework's dev server actually works on
a fetchlet environment is unverified.

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

- Does `vite/module-runner` evaluate on V8 the same way? QuickJS and Boa
  were checked; V8 was not run.
- How do source maps and stack traces from runner-evaluated code reach the
  Rust log?
- How does a release build guarantee the `vite-dev` and `dev` features are
  absent? Today it is the application's Cargo features.
- Which frameworks run on this path: TanStack Start, SolidStart and React
  Router need their server environment to be non-runnable, with the runner
  in the engine dispatching their requests.
