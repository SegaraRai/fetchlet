---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": patch
---

`WorkerOptions::cancelled_calls` chooses what the worker does with a call whose caller goes away while JavaScript runs it. `CancelledCalls::Retire`, the default, abandons the evaluation and rebuilds the instance as before; `CancelledCalls::Finish` lets the evaluation in progress return within the invocation deadline, then cancels an open response body and keeps the instance. `fetchlet_http::Server` uses `Finish` when it serves from a Vite dev server, so a request a client router cancels on navigation no longer makes the next request load every module from Vite again.
