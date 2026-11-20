---
"fetchlet": patch
---

`fetchlet/tanstack-start`, `fetchlet/solid` and `fetchlet/solid-start` keep the artifact consistent under `vite build --watch`: each server build waits for the client build in progress and rebuilds after every client build, so the artifact names the current client files, and a server build that a newer client build overtook is not written. SolidStart's first server build no longer fails, and TanStack Start and Solid no longer serve their development manifest or the previous client chunks.
