---
"fetchlet": minor
---

`fetchlet/solid-start` serves a fetchlet Rust host from `vite dev`, as `fetchlet/tanstack-start` does: SolidStart's server entry runs on the host's engine through Vite's module runner with the artifact's request context, while Vite serves the browser modules with Solid's hot module replacement. The plugin now returns an array of plugins. The development runner evaluates each module as a script rather than through the `Function` constructor, so the functions it declares keep their source text on Boa, which libraries such as seroval serialize.
