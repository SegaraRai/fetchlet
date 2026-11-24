---
"@fetchlet-crates/fetchlet": minor
---

Add `Limits::busy_timeout`, which stops JavaScript that runs that long without returning to the event loop with `LimitExceeded("engine busy time")`, and `Limits::startup_timeout`, which fails building an instance whose module runs that long with `DeadlineExceeded`. Both default to `None`. QuickJS and V8 stop JavaScript anywhere, V8 through a watchdog thread per instance; Boa stops it at its next promise job or host call, which now also applies the invocation deadline there. `BoaOptions::loop_iteration_limit` stops a Boa loop past that many iterations with an error JavaScript cannot catch. A stopped instance retires, and a pool replaces it.
