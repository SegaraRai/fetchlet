---
"@fetchlet-crates/fetchlet": minor
---

Stop JavaScript that never yields at the invocation deadline on QuickJS. An interrupt handler stops a loop, recursion, regular expression backtracking or an endless microtask chain that is still running when `Limits::timeout`, `background_timeout` or a response body's deadline passes; `try`/`catch` cannot catch the stop. The call fails with `DeadlineExceeded` and the instance retires, as it already did on V8.
