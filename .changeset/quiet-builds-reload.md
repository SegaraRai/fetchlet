---
"@fetchlet-crates/fetchlet-http": minor
---

The `dev` feature adds `DevReload`, which serves an artifact while a build tool rewrites it: when `fetchlet.json` changes it starts a new generation of the caller's services, shuts the previous applications down after their accepted calls, keeps serving the previous generation when a build fails, and reloads open HTML pages through a script element it appends, which loads a long-poll script from `/__fetchlet/reload.js`.
