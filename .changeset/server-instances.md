---
"@fetchlet-crates/fetchlet-http": minor
---

`Server::instances` sets the instances that serve requests, keeping the rest of the worker options. The axum examples read `max_instances`, `min_instances` and `instance_idle_timeout_ms` from their configuration. The default stays one instance.
