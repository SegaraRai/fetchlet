---
"@fetchlet-crates/fetchlet": minor
---

Stop an instance that reaches its heap limit with `LimitExceeded("engine heap")` and retire it. QuickJS now counts its allocations against `QuickJsOptions::memory_limit_bytes` itself, so exhaustion is named instead of surfacing as `Null"null"`, and JavaScript that catches the out-of-memory error is stopped too. `V8Options::heap_limit_bytes` limits a V8 isolate's heap and stops it near the limit instead of ending the process, and `V8Options::array_buffer_limit_bytes` limits `ArrayBuffer` storage, refusing past it with a `RangeError`.
