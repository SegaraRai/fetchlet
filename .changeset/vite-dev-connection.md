---
"@fetchlet-crates/fetchlet-http": minor
---

The `vite-dev` feature adds `ViteDev`, which runs a server module from a Vite dev server with `fetchlet/vite`: `artifact` reads the development artifact, `host_services` adds the `FETCHLET_VITE` binding the module runner reaches Vite through, and `proxy` serves Vite's browser modules and public files in front of the app.
