# fetchlet/runtime

The Web API profile and the Fetch entry that framework adapters build on.

`createFetchHandler` from `fetchlet/runtime/adapter` connects a function
over standard `Request` and `Response` to Rust's wire format. The second
argument is the per-call context. The same bundle can export plain
functions.

```ts
import { createFetchHandler } from "fetchlet/runtime/adapter";

export const handle = createFetchHandler(async (request: Request, context: { name: string }) => {
  return new Response("Hello, " + context.name);
});

export function add(left: number, right: number) {
  return left + right;
}
```

`getBindings()` returns the env values and services Rust fixed, and
`waitUntil(promise)` registers background work. JavaScript `fetch` goes to
Rust's host services. [Web API profile](../../../docs/web-api.md) lists what
the profile provides.

## Binding types

`fetchlet/bindings` declares `ServiceBinding`, a service's `fetch`, and
`FetchletBindings`, the bindings Rust's `HostServices` define. An application
declares its keys once; `getBindings()`, `ExportedHandler` and each
framework integration's request context are typed with them:

```ts
import type { ServiceBinding } from "fetchlet/bindings";

declare module "fetchlet/bindings" {
  interface FetchletBindings {
    MESSAGE: string;
    RUST: ServiceBinding;
  }
}
```

## Subpaths

| Subpath                    | Contents                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `fetchlet/runtime`         | The profile itself: installs the Web APIs, and exports the wire helpers             |
| `fetchlet/runtime/adapter` | Installs the profile, then exports `createFetchHandler`, `getBindings`, `waitUntil` |
| `fetchlet/runtime/handler` | The same exports without installing the profile                                     |
| `fetchlet/bindings`        | Types only: `ServiceBinding` and `FetchletBindings`                                 |

Framework integrations whose builder initializes the profile first use the
side-effect-free `fetchlet/runtime/handler`. That keeps Node-only polyfills
out of intermediate SSR builds such as Astro's and selects the providers
once, in the final embedded build.

## Providers

Encoding uses `@exodus/bytes/encoding-lite.js`: UTF-8, UTF-16 and
single-byte encodings, plus `TextEncoderStream` and `TextDecoderStream`.
Legacy multi-byte encodings are not included. Environments with native
Encoding keep it.

Streams are web-streams-polyfill 4.5.1, pinned. Fetch's `bodyUsed` needs the
stream's internal disturbed state, which `web/stream-state.ts` reads from
this provider through a dedicated seam. Updating the provider means
rechecking that seam with the conformance and regression tests for direct
readers, cancellation, clone and tee.

URLs are parsed by the host's `url` crate (WHATWG URL Standard). The
constructor, `URL.parse`, `URL.canParse` and each setter make one `url.parse`
or `url.set` host call and keep every returned component, so getters do not
cross the bridge. `searchParams` is the profile's URLSearchParams, updated in
both directions as the standard requires. Host call input and output count
against `bridge_message_bytes`. Hosts without fetchlet's host functions, such as
Node, use core-js's URL, and environments with native URL keep it.
URLSearchParams is core-js everywhere.

Request and Response bodies created from a string, BufferSource or
URLSearchParams stay bytes until `body` is read. `arrayBuffer()`,
`bytes()`, `text()`, `json()`, `formData()` and `clone()` use those bytes
without a stream, and a fully read body's `body` returns a disturbed, locked
stream. Once `body` is read, the body is a Fetch byte stream. A Fetch entry
response that is still bytes goes to the wire without a stream.

`Blob.stream()` returns a byte stream where ArrayBuffer transfer is
available, which is every engine with fetchlet's backends.

[Conformance](../../../docs/conformance.md) lists the tests that cover the
profile and its known differences.
