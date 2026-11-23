---
"fetchlet": minor
---

Polyfill `Intl.ListFormat`, `Intl.DisplayNames`, `Intl.RelativeTimeFormat`, `Intl.Segmenter` and `Intl.DurationFormat` with FormatJS when they are named in `requirements` or `intl.apis`, with their dependencies and the selected locales' data; `v8` builds leave them to the engine. `requirements` also accepts the engine-only APIs `Intl.Collator`, `Intl.supportedValuesOf`, `WebAssembly`, `SharedArrayBuffer` and `Atomics`: a `quickjs` or `boa` build that names one fails, a `v8` build checks it when the artifact starts, and a `portable` build records it in `needs` for the host to check.
