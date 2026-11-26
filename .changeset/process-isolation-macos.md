---
"@fetchlet-crates/fetchlet": minor
---

Process isolation enforces `ProcessOptions::memory_bytes` on macOS: the parent samples the child's physical footprint every 10 ms and ends the child with `LimitExceeded("process memory")` once it reaches the budget.
