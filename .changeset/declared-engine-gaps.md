---
"fetchlet": patch
"@fetchlet/web": patch
---

The polyfills and engine-only APIs that `fetchlet/build` plans with are declared by the new `@fetchlet/web/gaps` subpath, which also owns the FormatJS dependencies; `fetchlet` no longer depends on them directly. The native APIs per backend are generated from the measured polyfill matrix. Planned bundles are unchanged.
