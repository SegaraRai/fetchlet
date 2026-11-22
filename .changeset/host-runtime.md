---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": patch
---

`AppBuilder::host_runtime(handle)` polls host fetches and host bodies in the context of a shared Tokio runtime, so tasks, timers and I/O that host transports create, such as the connection task of a pooled HTTP client, keep running while an instance runs JavaScript. Without it, on QuickJS and Boa, another instance that reused such a connection waited for the first instance's evaluation to end. fetchlet-http's `Server` passes its runtime when it is a multi-thread runtime.
