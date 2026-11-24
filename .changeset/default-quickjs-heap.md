---
"@fetchlet-crates/fetchlet-http": minor
---

`Server` limits each QuickJS instance's heap to 64 MiB unless the backend sets its own limit, twice what the largest framework example needs, so that `Instances::max` times it bounds a pool's QuickJS heap.
