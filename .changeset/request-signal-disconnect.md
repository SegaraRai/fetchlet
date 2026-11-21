---
"@fetchlet/web": minor
"@fetchlet-crates/fetchlet": minor
---

The Fetch handler's `Request` signal aborts when the client goes away: when the host cancels the response body, and, with `CancelledCalls::Finish`, while the handler or a body pull is still running, so server-sent events and streaming renders can stop at once. `WireRequest` takes the `signal` the host passes, and `wireRequest` gives it to the `Request`.
