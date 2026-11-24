---
"@fetchlet-crates/fetchlet": minor
---

On QuickJS and V8, the instances built from one `AppBuilder` and its clones, such as those of one pool, reuse the compiled code of the first: QuickJS bytecode, and a V8 code cache made after the first run. A build after the first takes 77 to 88% less time in the framework examples. Setting another module on the builder starts a new cache. `Backend::with_default_quickjs_memory` sets a QuickJS heap limit where none is set.
