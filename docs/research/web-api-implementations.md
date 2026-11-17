# Research: Web API implementations for embedded engines

A source survey, made in November 2026, of Web API implementations that an
embedded engine could reuse instead of, or next to, fetchlet's portable
profile. It records what the sources contain; it is not a conformance
measurement. fetchlet's own profile is described in [Web API
profile](../web-api.md).

## Options

| Stack                              | What it offers                                  | Integration work                                                               |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| QuickJS / LLRT                     | A light engine and separate Web API modules     | Pin a version, connect Body and Streams, replace I/O with Rust host operations |
| V8 / Deno extensions / rustyscript | Broad Web APIs with existing initialization     | Permissions, a consistent set of crates, connection to Rust bodies             |
| Boa / boa_runtime                  | A Rust engine with basic Fetch, Encoding, Abort | Extend Request and Body; add Streams, FormData and more                        |

API presence, standards conformance, framework compatibility and conversion
to Rust are separate questions, and so are JavaScript Streams and the way a
body reaches Rust. The LLRT, Deno and boa_runtime stacks were surveyed from
source only; fetchlet's profile is what runs on all three engines today.

## Surveyed sources

| Subject                      | Registry version                    | Source examined                                                                  |
| ---------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| rquickjs                     | 0.14.0                              | Rust bindings; Web APIs are separate                                             |
| llrt_fetch / llrt_stream_web | 0.8.1-beta                          | Registry source archives                                                         |
| LLRT upstream                | manifest 0.10.0-beta, rquickjs 0.14 | `5f62b24cf647d20ad832f793993fd90b3137b0a2`                                       |
| boa_runtime / boa_engine     | 0.22.0                              | Published boa_runtime and boa_wintertc archives                                  |
| Boa upstream                 | development                         | `bea404d173bf74a64b7c7ae39b1bc2da639abeee`                                       |
| rustyscript                  | 0.12.3                              | Published archive; depends on deno_fetch ^0.237.0 and deno_web ^0.244.0          |
| rustyscript upstream         | manifest says 0.12.3                | `ef6ccee0eb45378dba540ebe78005f05ed3aa81b`; dependencies differ from the archive |
| deno_core                    | 0.413.0                             | Published metadata; Deno extension sources at the SHA below                      |
| Deno upstream                | development                         | `e7b39ebd55c85aaf6a29290c1f5a99e2e21e09dd`                                       |
| Hono upstream                | development                         | `f6fbaf0299c48eea9e656e03e2ffe7ac755e8823`                                       |
| SvelteKit upstream           | development                         | `407ef8cb1257d0d7529db6ebde1130654ffd8fe4`                                       |

Adopting Deno extensions means pinning the matching set of crates and
`Cargo.lock` together. Archive URLs, SHA-256 and VCS data are in
[release-source-manifest.json](2026-11-16/release-source-manifest.json);
the upstream files examined are in
[upstream-sources.json](2026-11-16/upstream-sources.json).

## API survey

"Yes" means the implementation and its registration were found in source;
"partial" means part of the behavior; "no" means the API was not found in
that stack's registration or implementation.

| API or behavior                      | LLRT crates 0.8.1-beta                 | LLRT upstream (pinned)       | rustyscript 0.12.3 + web | boa_runtime 0.22.0              |
| ------------------------------------ | -------------------------------------- | ---------------------------- | ------------------------ | ------------------------------- |
| Constructing Request                 | yes                                    | yes                          | yes                      | partial                         |
| Request url, method, headers in JS   | yes                                    | yes                          | yes                      | no                              |
| Response status, headers, text, json | yes                                    | yes                          | yes                      | yes                             |
| Request and Response arrayBuffer     | yes                                    | yes                          | yes                      | no                              |
| Binary BodyInit for Response         | yes, details unverified                | yes                          | yes                      | no; stringified                 |
| `Response.body` as ReadableStream    | no; `undefined`                        | yes                          | yes                      | no                              |
| ReadableStream, WritableStream       | separate module                        | yes                          | yes                      | no                              |
| TransformStream                      | no                                     | yes                          | yes                      | no                              |
| TextEncoder, TextDecoder             | in util                                | in util                      | yes                      | in text                         |
| TextEncoderStream, TextDecoderStream | no                                     | in util                      | yes                      | no                              |
| URL, URLSearchParams                 | in url                                 | in url                       | yes                      | URL only; `searchParams` throws |
| FormData, Blob, File                 | in fetch and buffer, partly compatible | yes, conformance unverified  | yes                      | no                              |
| `Request.formData`, multipart        | yes, details unverified                | yes                          | yes                      | no                              |
| `Request.formData`, URL-encoded      | partial; some paths are non-standard   | dedicated path               | yes                      | no                              |
| `Headers.getSetCookie`               | yes                                    | yes                          | yes                      | yes                             |
| AbortController, AbortSignal         | in abort                               | in abort                     | yes                      | partial                         |
| setTimeout, queueMicrotask           | in timers                              | in timers                    | yes                      | yes; the host must drive jobs   |
| structuredClone                      | not found in the modules alone         | in llrt_core                 | yes                      | yes                             |
| crypto, subtle                       | in crypto; algorithms not assessed     | yes; algorithms not assessed | crypto extension         | not in the standard set         |
| Outbound fetch                       | in fetch; needs HTTP initialization    | same                         | yes; host permissions    | needs an explicit Fetcher       |

## QuickJS and LLRT

rquickjs binds QuickJS-NG with Promise and Future integration, loaders and
value conversion; Web APIs are a separate layer
([rquickjs 0.14.0](https://docs.rs/rquickjs/0.14.0/rquickjs/)).

The published llrt_fetch 0.8.1-beta is buffer-centric: `Response.body` is
`undefined`, `Request.body` returns its input or null, and streaming is a
TODO. llrt_stream_web has Readable and WritableStream, and llrt_util has
TextEncoder and TextDecoder
([Response](https://docs.rs/crate/llrt_fetch/0.8.1-beta/source/src/response.rs),
[Request](https://docs.rs/crate/llrt_fetch/0.8.1-beta/source/src/request.rs),
[Streams](https://docs.rs/crate/llrt_stream_web/0.8.1-beta/source/src/lib.rs),
[util](https://docs.rs/crate/llrt_util/0.8.1-beta/source/src/lib.rs)).

`FormData.get` scans in reverse and returns the last value of a repeated
key. `Request.formData` goes through multipart, and input without a boundary
can yield an empty result
([FormData](https://docs.rs/crate/llrt_fetch/0.8.1-beta/source/src/form_data.rs)).

The pinned upstream adds ReadableStream bodies with tee on clone,
TransformStream and the Encoding streams
([Response](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_fetch/src/response.rs#L304),
[Streams registration](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_stream_web/src/lib.rs#L157),
[Encoding registration](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_util/src/lib.rs#L104)).

Embedding selects APIs with ModuleBuilder or individual init functions.
Fetch initialization also sets up an HTTP client, so type registration must
be separated from Rust-side network control. structuredClone is set up in
llrt_core's VM initialization
([ModuleBuilder](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/llrt_modules/src/module_builder.rs),
[fetch init](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_fetch/src/lib.rs#L28),
[VM init](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/llrt_core/src/vm.rs#L200)).

The published crates use rquickjs 0.11 and the pinned upstream 0.14; sharing
Value, Context and Class requires matching versions. The published archives
also carry VCS dirty flags and renamed dependencies, so source identity
must be checked against the manifest
([published manifest](https://docs.rs/crate/llrt_fetch/0.8.1-beta/source/Cargo.toml.orig),
[upstream manifest](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_fetch/Cargo.toml)).

## V8, Deno and rustyscript

deno_core provides JavaScript execution, the event loop and Rust ops.
Request and Response come from deno_fetch; Streams, Encoding, Blob and Abort
from deno_web; URL and Crypto from their own extensions.

rustyscript 0.12.3's `web` feature initializes Fetch and Web and enables URL
and Crypto. Its deno_fetch 0.237.0 implements Body methods, stream BodyInit,
multipart and URL-encoded forms and `getSetCookie`
([Fetch init](https://docs.rs/crate/rustyscript/0.12.3/source/src/ext/web/init_fetch.js),
[Web init](https://docs.rs/crate/rustyscript/0.12.3/source/src/ext/web/init_web.js),
[Body](https://docs.rs/crate/deno_fetch/0.237.0/source/22_body.js),
[Headers](https://docs.rs/crate/deno_fetch/0.237.0/source/20_headers.js)).

The default `safe_extensions` are web_stub, console, URL and Crypto; Request
and Response need the `web` feature, which also brings HTTP, TLS, net, fs and
import paths, so API exposure and operation permissions must be configured
separately. The default WebPermissions allow everything;
AllowlistWebPermissions is also provided
([manifest](https://docs.rs/crate/rustyscript/0.12.3/source/Cargo.toml.orig),
[permissions](https://docs.rs/crate/rustyscript/0.12.3/source/src/ext/web/permissions.rs)).

This is the candidate for a profile with broad standard APIs, to be compared
on a real application for bridge integration, startup time, RSS and size.

## Boa, boa_runtime and boa_wintertc

The published boa_runtime 0.22.0 Request class registers a constructor and
`clone`. Response offers string-centric bodies with status, headers, text,
json and bytes, and stringifies BodyInit. `URL.searchParams` throws a
not-implemented error
([Request](https://docs.rs/crate/boa_runtime/0.22.0/source/src/fetch/request.rs),
[Response](https://docs.rs/crate/boa_runtime/0.22.0/source/src/fetch/response.rs),
[URL](https://docs.rs/crate/boa_runtime/0.22.0/source/src/url.rs)).

`Headers.getSetCookie`, Encoding, timers, clone and basic Abort are
available. A Fetcher must be registered explicitly; ErrorFetcher enables the
related classes locally and BlockingReqwestFetcher performs blocking HTTP
([Headers](https://docs.rs/crate/boa_runtime/0.22.0/source/src/fetch/headers.rs),
[fetchers](https://docs.rs/crate/boa_runtime/0.22.0/source/src/fetch/fetchers.rs)).

boa_wintertc 0.22.0 contains empty register functions for fetch, encoding,
abort and others; boa_runtime's registrations are the reference
([WinterTC fetch](https://docs.rs/crate/boa_wintertc/0.22.0/source/src/fetch/mod.rs),
[encoding](https://docs.rs/crate/boa_wintertc/0.22.0/source/src/encoding/mod.rs)).

The pinned upstream adds Request accessors and body methods,
URLSearchParams and TypedArray support in Response. `Request.formData` turns
URL-encoded input into a plain object, keeping the last value of a repeated
key
([Request](https://github.com/boa-dev/boa/blob/bea404d173bf74a64b7c7ae39b1bc2da639abeee/core/runtime/src/fetch/request.rs#L242),
[formData](https://github.com/boa-dev/boa/blob/bea404d173bf74a64b7c7ae39b1bc2da639abeee/core/runtime/src/fetch/request.rs#L298),
[Response](https://github.com/boa-dev/boa/blob/bea404d173bf74a64b7c7ae39b1bc2da639abeee/core/runtime/src/fetch/response.rs#L281)).

Hono dispatches on `request.method`, so the published boa_runtime Request
would need accessors added — an inference from source. Boa with fetchlet's
profile passes the real fixtures
([Hono dispatch](https://github.com/honojs/hono/blob/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/hono-base.ts#L498)).

## Framework entry points

Hono uses `app.fetch(request)`, with TSX compiled at build time. The APIs it
needs grow with routes and middleware: Request, Response, Headers, URL,
Crypto, Streams
([Hono fetch](https://hono.dev/docs/api/hono#fetch),
[JSX](https://hono.dev/docs/guides/jsx)).

SvelteKit's server takes `env` and `read` at initialization and turns a
Request into a Response in `respond`; the pinned version uses
`generateServerInstance`
([server](https://github.com/sveltejs/kit/blob/407ef8cb1257d0d7529db6ebde1130654ffd8fe4/packages/kit/src/runtime/server/index.js#L37)).
`render` produces byte and stream Responses and `respond` uses
`getSetCookie`; actions and uploads need FormData and File, and internal
fetch, assets, client address and platform go through the adapter
([render](https://github.com/sveltejs/kit/blob/407ef8cb1257d0d7529db6ebde1130654ffd8fe4/packages/kit/src/runtime/server/page/render.js#L636),
[respond](https://github.com/sveltejs/kit/blob/407ef8cb1257d0d7529db6ebde1130654ffd8fe4/packages/kit/src/runtime/server/respond.js#L565)).
The Cloudflare output depends on `cloudflare:workers` and `ASSETS`, so
fetchlet has its own adapter targeting Web-standard build output
([Cloudflare worker](https://github.com/sveltejs/kit/blob/407ef8cb1257d0d7529db6ebde1130654ffd8fe4/packages/adapter-cloudflare/files/worker.js)).

## Probes

The 23 [behavior probes](../../fixtures/probe/README.md) passed 23 of 23 on
the Deno CLI 2.9.8 and Node 26.13.1 reference runs
([Deno](2026-11-16/probe-deno-reference.json),
[Node](2026-11-16/probe-node-reference.json)). Embedding LLRT, rustyscript
or boa_runtime directly would be evaluated with the same probes and
fixtures.
