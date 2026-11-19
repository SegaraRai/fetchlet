---
"fetchlet": minor
---

`fetchlet/tanstack-start` serves a fetchlet Rust host from `vite dev`, as `fetchlet/vite` does: Start's server entry runs on the host's engine through Vite's module runner with the artifact's request context, while Vite serves the browser modules with React Fast Refresh. The plugin now returns an array of plugins. The development runner resolves the server's dependencies with the `development` condition, prebundles their CommonJS modules, provides Node built-ins and `process`, `Buffer`, `setImmediate` and `clearImmediate` from the development artifact, and names the module whose evaluation failed.
