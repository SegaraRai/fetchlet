# Data flow

This page follows data through fetchlet: from framework source to an
artifact, from an HTTP request to JavaScript and back, and from JavaScript
`fetch` out to Rust. [Domain model](domain-model.md) defines the parts.

## Build: framework source to artifact

```text
framework source
    │  framework build (Vite, Nitro, …) with a fetchlet adapter
    ▼
server build + client assets
    │  fetchlet/build: virtual entry → Rolldown → one IIFE
    │    1. Web API profile (fetchlet/runtime)
    │    2. polyfills the target backend lacks (Intl via FormatJS)
    │    3. native capability checks (V8 builds)
    │    4. the framework's server build, wired to the Fetch entry
    ▼
artifact/
    server.js       IIFE; exports in fetchletExports, Fetch entry `handle`
    fetchlet.json   handler, backend, requirements, polyfills, intl, assets
    client/         static files, or
    assets.flpk     the same files as a Brotli asset archive
```

Each adapter hooks into its framework's build, passes `fetchlet/build` an
entry that connects the framework's server output to
`createFetchHandler`, and lets the framework emit its client assets. The
entry is a virtual module, so nothing is written next to the sources.
`archiveArtifactAssets` turns the client directory into an
[asset archive](asset-archive.md).

Rust reads the artifact at run time with `Artifact::open(dir)` or embeds it
with `fetchlet_http::include_artifact!(dir)`.

## Request: HTTP to JavaScript and back

```text
client ──HTTP──▶ server (axum, hyper, actix, Tower)
                   │ AssetService: GET/HEAD for an archived path → answered here
                   ▼
                 FetchletService
                   │ public origin replaces scheme and authority
                   │ RequestContext { clientAddress } or a custom context
                   │ trusted Context from Rust middleware
                   │ request body collected within request_body_bytes,
                   │   or streamed with stream_request_bodies()
                   ▼
                 AppHandle ──queue──▶ worker thread
                                        │ Instance, new Invocation
                                        ▼
                                      wire request ──▶ Fetch entry (JS)
                                                         new Request(...)
                                                         framework handler
                                      wire response ◀── Response
                   ◀── http::Response<Body> as soon as the head is ready
client ◀──HTTP── body streams while the worker pulls it from JavaScript
```

The wire request carries the URL, method, header pairs and the body: bytes
for a buffered body, or a body source for a streamed one. Binary bodies
cross the bridge as typed arrays through the invocation's byte store; the
JSON messages carry only handle numbers.

## Response bodies

```text
JS Response body ──pull on demand──▶ bounded queue ──▶ Rust Body ──▶ client
                         │
               Invocation and Instance lease
```

- `AppHandle::fetch` returns once the handler produces the response head.
  The worker pulls body chunks as the queue (`response_body_queue`, default
  one chunk) has room. JavaScript merges available chunks up to 64 KiB per
  bridge message; that is backpressure granularity, not a budget.
- While the body is unfinished the invocation keeps its scope, deadline and
  instance, and the worker starts no other call.
- `timeout` covers the call until the body completes, including time the
  worker waits for the consumer to make room. When it passes, the body ends
  with `DeadlineExceeded` after the chunks already queued, and the worker
  releases the instance without waiting for the consumer. `response_body_bytes`
  is checked against the running total; exceeding it cancels the JavaScript
  stream.
- Dropping the Rust body between pulls cancels the JavaScript stream
  cooperatively and keeps the instance. Dropping it during a pull abandons
  the evaluation and retires the instance.
- `App::fetch` uses the same path and collects the whole body.

A response whose body is still bytes (a string or buffer passed to
`new Response`) goes to the wire without creating a stream.

## Request and upstream bodies

```text
Rust Body (incoming request, upstream response)
    ──▶ body source owned by the Invocation
    ──▶ body.read on demand
    ──▶ JS ReadableStream
```

- A body that is not buffered — wrapped with `Body::from_http_body`, or
  passed through by `stream_request_bodies()` — reaches the handler as
  `request.body` and is read one chunk at a time.
- A declared length (size hint or `Content-Length`) over
  `request_body_bytes` fails before execution with `LimitExceeded`.
  Undeclared excess is detected from the running total and errors the stream
  with code `LIMIT_EXCEEDED`. A failing body errors it with `TRANSPORT`; the
  detail stays in Rust.
- Upstream response bodies of host fetches use the same body sources under
  `response_body_bytes`. Bodies of followed redirects are discarded unread.
- Cancelling the stream, aborting the fetch, finishing the body or ending
  the invocation drops the body source, which cancels the producer.
- Outbound request bodies are read in full inside JavaScript before they
  are sent, because a redirect may resend them.

## Outbound fetch: JavaScript to Rust

```text
fetch(url, init)  or  fetchlet.env.NAME.fetch(url, init)
    │ read body; check body, chunk and message budgets
    │ count a subrequest; pick the service (outbound or named)
    ▼
FetchService
    1. rewrite        Rust callback may change the request
    2. authorize      final origin, method, headers and body checked
    3. credentials    Rust callback attaches secrets for this send only
    4. transport      single hop: HTTP client, Rust handler, axum router
    5. redirect       next request built from the pre-credential request,
                      checked again; cross-origin hops drop guest credentials
    ▼
Response (any status) ──▶ JS Promise resolves
error (denied, transport, cancelled, reentrant) ──▶ JS Promise rejects
                                                    with a stable code
```

The invocation polls transport futures directly and wakes the engine on a
waker notification or the next JavaScript timer. With `OriginRouter`, an
internal origin is handled in-process by a Rust handler or axum router that
receives the trusted `Context`; [in-process fetch](in-process-fetch.md)
describes the routing and reentrancy rules.

## Background work

`fetchlet.waitUntil(promise)` — exposed by `fetchlet/runtime` and passed to
frameworks as `platform.context.waitUntil` (SvelteKit),
`Astro.locals.waitUntil` and similar — registers work that may outlive the
response.

- Registration is accepted only during an invocation; `background_tasks`
  limits the count (`LIMIT_EXCEEDED`), and outside an invocation it fails
  with `INVOCATION_CLOSED`.
- When the result or body finishes with work pending, the invocation stays
  open with its host scope and timers; host fetches and upstream reads
  continue.
- `App::finish_background` waits for the work, within `background_timeout`
  counted from the end of the result or body. Work that misses the deadline
  retires the instance and reports `DeadlineExceeded`. An `AppHandle` worker
  finishes background work before its next command.
- Rejections are absorbed; they do not change the response.

Without background work, remaining timers are discarded when the call ends.

## Cancellation and errors

Cancellation travels with ownership. Dropping the call's future, an expired
deadline or a disconnected client ends the invocation, which drops its host
futures and body sources, which cancels their producers. An instance whose
state is then uncertain is retired. A worker with
`CancelledCalls::Finish` does not drop the call when its caller leaves: the
evaluation in progress returns within the deadline, an open body is then
cancelled, and the invocation ends normally.

| Where it fails                | What the caller sees                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| Rust API (`App`, `AppHandle`) | A detailed `fetchlet::Error`                                         |
| `fetchlet-http` service       | `on_error` receives the detail; the client receives a general status |
| JavaScript host operation     | A rejection or exception with a stable `code` and a general message  |

[fetchlet-http](../crates/fetchlet-http/README.md#errors) lists the HTTP
statuses.
