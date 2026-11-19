---
"fetchlet": minor
---

`fetchlet/react-router` exports `fetchletDevServer`, a Vite plugin beside `reactRouter()` that serves a fetchlet Rust host from `vite dev`: React Router's server build runs on the host's engine through Vite's module runner with the preset's load context, while Vite serves the browser modules with React Fast Refresh. Development serving now keeps every module of the server environment internal, since the engine loads only what Vite transforms.
