---
"@fetchlet-crates/fetchlet": minor
"@fetchlet-crates/fetchlet-http": minor
---

Process isolation enforces `ProcessOptions::memory_bytes` on Linux too, through `RLIMIT_DATA` in the child, and adds `ProcessOptions::stack_bytes` for the child's engine thread. `Error::InstanceLost` names the child's last report on standard error, which the parent passes on to its own. The child answers `fetch.limits` and `invocation.disconnected` itself and stores bytes without waiting for the parent, so a page crosses the process boundary less often. fetchlet-http's new `process` feature adds `Server::isolation`, whose children get the server's worker stack.
