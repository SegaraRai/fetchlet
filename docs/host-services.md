# Host services

`HostServices` is the authority an app receives from Rust: environment
values, named services, outbound fetch and a console sink. This page covers
configuring them and the contracts they keep.

## Bindings

```rust,ignore
use fetchlet::{
    App, Backend, Body, FetchPolicy, FetchService, HostServices,
    Module, Response, transport_fn,
};

let policy = FetchPolicy::deny_all()
    .allow_origin("https://api.example.test")?;

let service = FetchService::new(
    transport_fn(|request| async move {
        let message = format!("handled {}", request.uri().path());
        Ok(Response::new(Body::from(message)))
    }),
    policy,
);

let hosts = HostServices::new()
    .outbound(service.clone())
    .service("API", service)?
    .env("APP_ENV", "production")?;

let mut app = App::builder(Backend::quickjs())
    .module(Module::new(bundle))
    .host_services(hosts)
    .build()?;
```

JavaScript uses `fetch(url, init)`, `fetchlet.env.API.fetch(url, init)` and
`fetchlet.env.APP_ENV`. `getBindings()` from `fetchlet/runtime/adapter`
returns the same object. The bindings are a read-only, null-prototype
object installed before the module is evaluated. Rust decides every value
and service in it. Pass JavaScript only what it must read; keep upstream
credentials in Rust, in the service's credentials callback.

`App` runs calls one at a time through `&mut self`. QuickJS and Boa run on
the caller's thread; V8 keeps a dedicated worker per isolate. `AppHandle`
manages the thread and queue itself.

## Console

The callback passed to `HostServices::console` receives each
`console.debug`, `log`, `info`, `warn` and `error` call as a `ConsoleLevel`
and one formatted line. Frameworks such as SvelteKit report server errors
with `console.error`, so forwarding them to Rust logs makes failures
visible.

```rust,ignore
let hosts = HostServices::new()
    .console(|level, message| eprintln!("[js {level:?}] {message}"));
```

Strings are kept as they are, errors become their stack (or name and
message), objects become JSON and other values `String(value)`; the parts
are joined with spaces. Each call is one bridge message; one larger than
`Limits::bridge_message_bytes` is replaced with
`[fetchlet: console message dropped]`. Console calls never throw into the
application. The callback runs on the JavaScript thread, so hand heavy work
to another thread or queue. Without a sink, console output is discarded.
`crates/fetchlet/tests/app.rs` checks the contract on all three engines.

## Bundle entry

A module is a built IIFE that puts its exports on `fetchletExports`.
`App::call` and `call_json` call any export; `fetch` calls the Fetch entry,
`handle` unless `AppBuilder::fetch_handler` names another.

The Fetch entry converts the URL, method, header pairs and body into a Web
`Request` and converts the returned `Response` back.
`createFetchHandler` in `fetchlet/runtime/adapter` builds one from a
standard handler; the framework adapters in the `fetchlet` package build
their entries with it. `fixtures/hono.tsx` and `fixtures/sveltekit/entry.ts`
are small examples.

`App::fetch_with_context(request, &context)` passes a Serde value as the
entry's second argument. `fetchlet-http` uses it for
`RequestContext { clientAddress }`.

## Calling Rust in-process

The `transport_fn` above answers with a Rust function directly. Registered
as `outbound`, it serves global `fetch`; registered as a service, it serves
`fetchlet.env.API.fetch`. No HTTP connection or listening socket is needed,
and the same authorization and budgets apply.

`OriginRouter` selects a transport by exact origin and builds a service that
allows only the registered origins. Internal routes receive the `Context`
from the extensions of the request given to `App::fetch`. Internal origins
are ordinary `https://` origins under the private `.internal` domain; the
examples use `https://fetchlet.internal`, and an application can choose its
own names or register several. `fetchlet_http::router_transport` lets one axum router serve both public
HTTP and in-process fetches. Calling the same `AppHandle` while one of its
host fetches is running fails with `Error::Reentrant`. [In-process
fetch](in-process-fetch.md) has the details.

## Fetch processing order

1. Read the JavaScript request body and check the body, chunk and message
   budgets.
2. Count a subrequest against the invocation and select the service.
3. Let the Rust rewrite callback change the request.
4. Check the rewritten origin, method, headers and body.
5. Attach credentials with the credentials callback and normalize transport
   headers.
6. Run the single-hop transport.
7. To follow a redirect, build the next request from the request before
   credentials and run the same checks.

Origins match exactly after normalizing scheme, host and port. Headers added
by the credentials callback live for one send. A redirect to another origin
also removes guest-supplied `Authorization`, `Cookie` and similar headers.

`FetchService::rewrite` runs before authorization and `credentials` after
it, so the credentials callback can restrict each secret to the URL it is
given.

## Transport contract

A transport is a trusted Rust implementation. It must answer a single hop,
stop work when its future is dropped and enforce the body budget while
receiving. A real HTTP client must also check DNS results and the address it
connects to: the origin policy authorizes URLs, and the transport controls
network reachability.

The invocation polls the transport future directly and wakes the engine on
the future's waker or the next JavaScript timer; there is no periodic
polling.

A transport may return a streaming body (`Body::from_http_body`). A guest
fetch reads it on demand as a `ReadableStream` and checks
`response_body_bytes` against the declared length and the running total.
Cancelling or aborting in JavaScript, or ending the invocation, drops the
body and cancels the transport. `FetchService::fetch`, called from Rust,
collects the body within the budget.

## Bodies and lifetime

The public types are `http::Request<Body>` and `http::Response<Body>`.
`Body` implements `http_body::Body` and holds a buffer, a stream from the
worker, or any wrapped `http_body::Body`. Binary bodies and repeated
`Set-Cookie` headers are preserved.

When an invocation ends it drops its transport futures synchronously. After
a normal completion, or a JavaScript exception with nothing pending, the
instance is reused. A dropped Rust future, an expired deadline or a return
with host fetches still pending retires it; `App::is_reusable()` reports
this, and calls on a retired `App` fail with `InstanceUnavailable`.
`AppHandle` rebuilds the instance instead.

Timers left when a call ends are discarded. A streaming body holds its
invocation until it completes or is cancelled, and work registered with
`fetchlet.waitUntil` keeps the invocation open within `background_timeout`
and `background_tasks` ([data flow](data-flow.md#background-work)).

## Budgets

`AppBuilder::limits(Limits)` sets budgets for the use case. Each field is an
`Option`; `None` leaves that budget to the surrounding server or process
supervisor, and every field defaults to `None`. Engine heap and stack
settings live in `QuickJsOptions` and `V8Options`. [Resource
policy](resource-policy.md) lists them with their scopes.

## Shared handles and HTTP

`AppBuilder::spawn` returns an `AppHandle` that clones share for functions,
Fetch and Fetch with context, with an explicit queue capacity
([crate README](../crates/fetchlet/README.md)).
[fetchlet-http](../crates/fetchlet-http/README.md) connects it to HTTP
servers; the same request handling contract runs against every layer.

| Feature | Adds                                                                     |
| ------- | ------------------------------------------------------------------------ |
| (none)  | `FetchletService` (Tower and `http` 1), in-process transport, `Artifact` |
| `hyper` | `HyperService`, with hyper 1 connections and the peer address            |
| `axum`  | `AxumService`, `ConnectInfo`, `router_transport`, `artifact_router`      |
| `actix` | `ActixService` for actix-web 4                                           |

## Tests

`vp run test:host` sends real JavaScript fetches through mock transports on
all three engines: permissions, binary POST, cookies, credentials,
redirects, rewrites, env, named services, abort and instance retirement.
Results are in [reference](reference/README.md#host-services). The
implementation is in `crates/fetchlet/src/host/`,
`crates/fetchlet/src/bridge/` and `crates/fetchlet/js/host-bridge.js`, with
Web API operations in `crates/fetchlet-web/`; the
runner is in `tools/lab/`.
