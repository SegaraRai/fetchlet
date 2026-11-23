---
"fetchlet": minor
"@fetchlet/web": minor
"@fetchlet/node": minor
---

Record what an artifact needs from its host as `needs` in `fetchlet.json`: the Intl APIs left to the engine and their locales, async context, and the fetchlet-web APIs and protocol the bundle calls. Every framework adapter accepts `requirements`, which names Intl APIs and globals over host Web APIs such as `crypto.subtle` or `CompressionStream`; imports of `node:crypto` and `node:zlib` add the host APIs they call. A requirement name that is neither now fails the build instead of passing unchecked. `@fetchlet/web/capabilities` exports `PROTOCOL_VERSION` and the host API behind each global, and `@fetchlet/node/host-apis` the host APIs behind each module.
