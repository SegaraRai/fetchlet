---
"@fetchlet-crates/fetchlet": patch
---

On V8, tasks that host services spawn while a call runs, such as the connection a pooled HTTP client keeps open, run on the caller's Tokio runtime and keep running between calls. They used to stay on the isolate thread's own runtime, which runs only during a call, so a request that reused such a connection from another worker could stall until that worker ran again.
