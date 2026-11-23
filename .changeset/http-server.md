---
"@fetchlet-crates/fetchlet-http": minor
"@fetchlet-crates/fetchlet": minor
---

fetchlet-http's `axum` feature adds `Server`, which serves one `fetchlet/build` artifact behind the caller's Rust routes: it starts the engine the artifact was built for, makes host services and routes for each application, defaults to a queue of 8 that makes further requests wait, a 64 MiB worker stack, and engine stack limits that fit framework server renderers, with a Boa recursion limit of 10,000 calls instead of 512, and shuts down after Ctrl-C. With the `dev-reload` feature it serves each new build through `DevReload`, and with `vite-dev` and `FETCHLET_VITE_URL` it runs the server module from a Vite dev server. The `axum` feature now enables Tokio's `net` and `signal` features, and `Server` is available when the fetchlet crate has an engine feature, which fetchlet now reports to dependent build scripts through `links = "fetchlet"`. fetchlet adds `Backend::for_target`, which selects the engine for an artifact's `backend` and names the Cargo feature it needs, and `with_default_quickjs_stack` and `with_default_boa_stack`, which takes a value stack and a recursion limit.
