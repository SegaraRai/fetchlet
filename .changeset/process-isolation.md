---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": patch
---

Add process isolation behind the `process` feature: `AppBuilder::isolation(Isolation::Process(ProcessOptions))` runs each instance's engine in a child process, with host services kept in the parent. The parent stops the child at the invocation deadline, past the busy timeout and when a call is dropped, on every engine, so `Requirements::preemption` is met on Boa too. `ProcessOptions::memory_bytes` bounds the child's memory on Windows and reports `LimitExceeded("process memory")`. A child that ends otherwise fails the call with the new `Error::InstanceLost`, which fetchlet-http answers with 503. Executables call `fetchlet::serve_if_child()` first thing in `main`.
