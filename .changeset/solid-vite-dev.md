---
"fetchlet": minor
---

Serve Solid 2 applications from `vite dev`: `fetchlet/solid` runs Solid's request handler on the engine of a Rust host with fetchlet-http's `ViteDev`, as `fetchlet/solid-start` does for SolidStart. The plugin now returns an array of plugins.

`fetchlet/vite`'s development runner sends `fetch` to the Vite dev server's own origins through the host's `FETCHLET_VITE` binding, so frameworks that fetch their development endpoints from the server, such as Solid's asset manifest, work without a fetch policy that admits them.

An edit to a server module under `vite dev` now evaluates only the edited modules and their importers again in the engine, rather than every module, so development instances keep within their heap limit.
