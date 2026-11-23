---
"@fetchlet-crates/fetchlet": minor
---

`HostServices::functions(name, Functions)` binds Rust functions that JavaScript calls as the methods of `fetchlet.env.NAME`, a frozen object of exactly those methods. `Functions::method` adds an async method, which returns a Promise whose future is polled with the invocation's host operations, under its deadline, and dropped when it ends; `sync_method` adds one that returns at once. `FunctionRequest::args` deserializes the JSON arguments with serde, and arguments it cannot read throw a `TypeError` naming the method; `FunctionError::new(message).code(code)` arrives as an `Error` with that message and `code`, a fetchlet `Error` as a host error, and a panic fails the call with `PANICKED`. `request.context()` gives the invocation's trusted `Context`. The new `Limits::function_calls` bounds the calls per invocation, and `bridge_message_bytes` bounds each result.
