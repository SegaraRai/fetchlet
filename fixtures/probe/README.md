# Web API probes

`web-api.js` checks 29 local behaviors: binary bodies, Body consumption,
repeated cookies, FormData, Streams, cancellation, Encoding, Abort,
microtasks, timeouts and intervals, EventTarget and events, navigator
and reportError, clone, Crypto, compression, URLPattern and a synthetic
handler.

## Reference runs

These run from the repository root without installing anything:

```bash
deno run --no-config --no-lock fixtures/probe/run.ts
node fixtures/probe/run.ts
```

The Deno CLI and Node are the reference environments. Embedded results come
from runs that initialize each engine with the Web API profile.

## Embedded runs

```bash
vp run build:fixtures
vp run test:matrix
```

Results for QuickJS, Boa and V8 with fetchlet's profile go to
`results/web-api-{backend}.json` and are rendered in
[reference](../../docs/reference/README.md#web-api-probes).

To evaluate another profile, initialize its Web APIs and host features,
evaluate the script, and drive the promise of
`globalThis.fetchletProbe({ runtimeLabel })` from the host.

Each check uses a two-second test timeout where the environment allows; the
host's deadline guards the whole run. The probes cover these 29 behaviors
only. Real HTTP, Rust body backpressure and full specification conformance
have their own tests.
