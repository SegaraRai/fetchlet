# In-process fetch

Framework server code can call Rust handlers and routers through `fetch`
without an HTTP connection. fetchlet routes such requests by origin, carries
a trusted `Context` to them, reuses axum routers and detects reentrant
calls. [Host services](host-services.md) covers the general API.

## Model

```text
Rust host ── Request + Context ──▶ framework server-side JS
                                         │ fetch(Request)
                                         ▼
                          FetchService (rewrite → authorize → credentials)
                                         │
                               OriginRouter (exact origin)
                        ┌────────────────┴────────────────┐
                  internal route                    external route
           Rust handler / axum router           network client, …
             (receives the Context)            (Context removed)
```

JavaScript uses Fetch `Request` and `Response` to reach Rust APIs. Internal
destinations complete inside the process and share the Rust application's
state. External destinations go to transports registered separately.

## API

| API                                 | Role                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `FetchTransport` / `transport_fn`   | The single-hop async boundary; connects a Rust function. `Arc<T>` also works |
| `OriginRouter::internal(origin, t)` | Registers a trusted transport for an origin; it receives the Context         |
| `OriginRouter::external(origin, t)` | Registers a transport for an origin; the Context is removed                  |
| `OriginRouter::into_service()`      | A `FetchService` that allows only the registered origins                     |
| `Context`                           | Typed values built in Rust and placed in the extensions of the app's request |
| `FetchService::forward_context()`   | Passes the Context on a single-transport service; others remove it           |
| `fetchlet_http::service_transport`  | Turns any Tower service into a transport                                     |
| `fetchlet_http::router_transport`   | Turns an axum `Router` into a transport (`axum` feature)                     |
| `trusted_context`                   | Builds a Context from the incoming request (each fetchlet-http service)      |

```rust,ignore
let service = OriginRouter::new()
    .internal("https://fetchlet.internal", router_transport(api_router(state.clone())))?
    .external("https://api.example.com", network_client)?
    .into_service();
let services = HostServices::new()
    .outbound(service.clone())
    .service("API", service)?;
```

## Routing

`OriginRouter` matches the origin exactly after normalizing scheme, host and
port.

1. A request to a registered origin is handled by that transport only.
2. A 404 or 500 from the transport reaches JavaScript as that API's HTTP
   response.
3. An unregistered origin is refused by the policy with `PERMISSION_DENIED`
   and calls no transport. There is no fallback to another route or the
   network.
4. The destination is classified and authorized after rewriting, and
   credentials are bound to the final destination.
5. Each redirect hop is classified and authorized again. A redirect from an
   internal to an external origin proceeds only if that origin is
   registered, and that hop carries no Context.

Registering an origin twice, or an origin with a path or query, is a
configuration error.

## Naming internal origins

Internal origins are ordinary `https://` origins, so the WHATWG URL parser,
Fetch `Request`, redirects and framework clients treat them like any other
HTTP destination and give each one a distinct origin. A custom scheme such as
`fetchlet://` would have the opaque origin `null`, which exact origin routing
cannot distinguish, and other runtimes reject it in `fetch`.

The examples use `https://fetchlet.internal`. The name is the application's
choice; the router only compares origins exactly.

- Use a host under `.internal`, a top-level domain that ICANN reserves for
  private use and never delegates in public DNS, so an internal name cannot
  collide with a real site.
- An application can register several internal origins to keep its APIs
  apart, such as `https://api.fetchlet.internal` and
  `https://search.fetchlet.internal`, each with its own transport.
- An origin reaches only the transport registered for it. Leaving one out
  makes requests to it fail with `PERMISSION_DENIED`; they never reach the
  network.

## Trusted Context

Rust builds the `Context`: an authenticated principal, a tenant, a trace
parent.

- A `Context` in the extensions of the request given to `App::fetch` or
  `AppHandle::fetch` is kept by that invocation. It is not part of the wire
  request JavaScript receives.
- Host fetches of that invocation carry a clone in their request
  extensions. Only internal routes and services with `forward_context()`
  receive it.
- JavaScript cannot read, create or replace the Context, and no Context is
  ever built from request headers.
- The fetchlet-http services (`FetchletService`, `HyperService`,
  `AxumService`, `ActixService`) build it with `trusted_context` from
  connection info or the result of authentication middleware; axum handlers
  read it with `Option<Extension<fetchlet::Context>>`.
- Each hop's request inherits the extensions, so redirects between internal
  routes keep the Context.

The Serde value of `App::fetch_with_context` is the entry's second argument:
a separate value meant to be visible to JavaScript.

## Reusing an axum router

`router_transport(router)` lets one axum router serve public HTTP and
in-process fetches.

- Method, absolute URI, headers, body and extensions are passed as they are;
  the router dispatches on the path.
- The response body streams back to JavaScript within
  `response_body_bytes`.
- Aborting the fetch or ending the invocation drops the handler's future.
- In-process requests have no `ConnectInfo` or other connection data; pass
  what handlers need in the Context.

## Cancellation, bodies and errors

`AbortSignal`, dropping the host future and the call deadline are tied
together. Aborting drops the handler's future without waiting for the
invocation to end. Bodies stream on demand and hold the invocation's lease
until they complete or are cancelled ([data flow](data-flow.md)).

| Result in Rust                                      | In JavaScript                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| An HTTP response, including 404 and 500             | The fetch promise resolves with the Response                       |
| Permission denied, transport `Err`, cancel, reentry | The fetch promise rejects with a stable code and a general message |

## Reentrancy

An `AppHandle` runs one instance serially. Calling the same handle from
inside one of its host fetches would wait for itself.

- While the worker polls host futures it records the app's identity in a
  thread-local. A call to the same app during that time fails immediately
  with `Error::Reentrant` (code `REENTRANT` in JavaScript). A rebuilt
  instance keeps the same identity.
- Calls to another app's `AppHandle` run normally.
- Detection covers calls made directly inside the poll of a host future. A
  handler that `tokio::spawn`s a task which calls the same app and waits for
  it is not detected; it waits until `Limits::timeout`.

## Framework fetches

With SvelteKit's `event.fetch`:

- Same-origin relative and absolute URLs are handled by the framework as
  its own routes inside JavaScript; no host fetch is made.
- URLs of other origins go to global `fetch`, served by the
  `HostServices::outbound` service. Headers the framework adds, such as
  forwarded cookies, follow the framework's rules.
- Named bindings such as `platform.env.RUST` call their service without the
  framework.

Other frameworks split the same way where they have a fetch of their own.
An absolute URL on the application's public origin through global `fetch`
is a host fetch in every framework, so the fetch policy decides it: the
examples, which register only `https://fetchlet.internal`, refuse it with
`PERMISSION_DENIED`.

| Framework                                                  | Fetch that stays inside the framework                                                                                                                                | How it is checked                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| SvelteKit                                                  | `event.fetch`, relative or same-origin                                                                                                                               | examples/sveltekit-axum end-to-end checks                                                |
| Nuxt and Nitro                                             | `event.$fetch` and `event.fetch` with a path, which keep `event.context.fetchlet`; global `$fetch` with a path also stays in Nitro but without the request's context | examples/nuxt-axum end-to-end checks                                                     |
| SolidStart                                                 | `fetchWithEvent(event, path)` from `@solidjs/start/http` (h3's), with the request's context                                                                          | examples/solidstart-axum end-to-end checks                                               |
| TanStack Start                                             | None found                                                                                                                                                           | Its server core, read at the version in reference, does not export h3's `fetchWithEvent` |
| Astro, React Router, Qwik City, Waku, vinext, HonoX, Solid | None: loaders, actions and server components call code directly, and `fetch` has no relative base                                                                    | Their server runtimes, read at the versions in [reference](reference/README.md#examples) |

vinext replaces global `fetch` with Next's caching fetch; it calls the
original `fetch`, so its requests are host fetches like any other.

Internal origins identify destinations for server-side JavaScript only.
Browsers receive URLs on the public origin (`/api/v1` in the example), which
reach the same router.

## Tests

| Scope                                           | Tests                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Context attach and removal, exact origins       | `crates/fetchlet/src/host/tests.rs`                                                 |
| Context, redirects, refusal, reentry, 3 engines | `crates/fetchlet/tests/in_process.rs`                                               |
| Shared axum router, `trusted_context`           | `crates/fetchlet-http/tests/axum_router.rs`, `crates/fetchlet-http/tests/contract/` |
| End to end with SvelteKit                       | [examples/sveltekit-axum](../examples/sveltekit-axum/README.md)                     |
| Framework fetches of Nitro and SolidStart       | examples/nuxt-axum and examples/solidstart-axum, `framework-fetch` checks           |

The example checks the router over public HTTP and in-process fetch, 400,
404 and 500 responses, the caller identity from the Context, refusal of an
unregistered origin, handler drop on abort and the `event.fetch` split.
