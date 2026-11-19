---
"@fetchlet-crates/fetchlet-http": minor
---

`DevReload` serves hosts without a Tower service, such as a Tauri URI scheme: `current()` returns the service of the generation being served, and `reloads()` reports each new generation so the host can reload its views. `shutdown` takes `&self`, so a host that shares the `DevReload` can shut it down.
