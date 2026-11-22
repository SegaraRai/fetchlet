---
"@fetchlet/web": minor
"fetchlet": minor
---

`upgradeWebSocket(request, { protocol })`, exported from `fetchlet/runtime` and `@fetchlet/web/websocket`, accepts a Fetch request's WebSocket upgrade on the fetchlet App host and returns the socket and the response to return, as Deno's does. The socket implements the WebSocket interface with `CloseEvent`. Under `vite dev`, `fetchlet/runtime` imported by a server module is now the development artifact's copy, so the Web API profile is installed once.
