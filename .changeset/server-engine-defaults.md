---
"@fetchlet-crates/fetchlet-http": minor
---

`Server` now runs with `Server::default_limits()`, a 10 s `busy_timeout` and a 60 s `startup_timeout`, unless `limits` replaces them, and its default backend has a 64 MiB V8 heap limit as QuickJS has. Start a `Limits` from `Server::default_limits()` to keep the timeouts, or from `Limits::default()` to run without them.
