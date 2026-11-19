---
"fetchlet": minor
---

`fetchlet/vite` serves a fetchlet Rust host from `vite dev`: it builds a development artifact whose server module, `fetchlet/vite/dev-runner`, runs Vite's module runner in the engine and loads the server module from the `ssr` environment, reloading changed modules and their importers before each call. Browser entries load through `/@fetchlet/client?entry=…` with Vite's HMR client, and a server change reloads open pages.
