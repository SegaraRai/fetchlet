---
"@fetchlet-crates/fetchlet": minor
---

Add `V8Options::reliable_termination`, which compiles V8's on-stack replacement code on the instance's thread (`--no-concurrent-osr`) so that the time limits and the heap limit also stop hot loops that allocate, such as one around `new Array(1000).fill(0)`, which V8 otherwise runs on. It is off by default, applies to the whole process, and must be set on the first V8 instance the process starts; setting it later fails with `Error::Configuration`. `V8Options::heap_limit_bytes` below the new `MIN_V8_HEAP_LIMIT_BYTES` (16 MiB) now fails with `Error::Configuration` instead of ending the process while the isolate starts. `Backend::with_default_v8_heap` sets a V8 heap limit where none is set.
