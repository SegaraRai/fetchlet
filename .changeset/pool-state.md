---
"@fetchlet-crates/fetchlet": minor
---

`AppHandle::pool_state` returns a `PoolState` for operators: instances building, idle, busy and retiring, commands queued and connection places taken at that moment, the pool's `min`, `max`, queue capacity and `max_held_connections`, and totals since the spawn of builds, failed builds, build time, instances replaced after a call left them unusable, idle retirements and refused connection places.
