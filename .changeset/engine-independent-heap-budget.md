---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": minor
---

The engine heap budget is `Limits::heap_bytes`, shared by every engine, in place of `QuickJsOptions::memory_limit_bytes` and `V8Options::heap_limit_bytes`; `Backend::with_default_quickjs_memory` and `Backend::with_default_v8_heap` are removed. QuickJS and V8 enforce it as before, and `V8Options::array_buffer_limit_bytes` defaults to it. Boa has no heap limit, so an App on Boa with a heap budget now fails to build with `Error::Configuration` instead of running without it; `Backend::bounds_heap` tells which engines enforce one. The new `Requirements::preemption` refuses, at build time, an engine that cannot stop JavaScript that never yields: Boa, and V8 without `V8Options::reliable_termination`. fetchlet-http's `Server` sets its 64 MiB default as `Limits::heap_bytes` when it chooses a QuickJS or V8 backend and the limits have none.
