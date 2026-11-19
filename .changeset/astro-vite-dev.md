---
"fetchlet": minor
---

`fetchlet/astro` takes `devServer: true`, with which `astro dev` serves a Rust host that uses fetchlet-http's `ViteDev`: the host runs Astro's development app on its engine through Vite's module runner. The development server plugin now clears the server environment's `resolve.external`, points the HMR client at Vite's own port, and reloads open pages for server-only changes before the framework's own `hotUpdate` handlers run.
