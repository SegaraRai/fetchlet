---
"fetchlet": minor
---

Framework apps accept server WebSockets. `fetchlet/runtime/handler` and `fetchlet/runtime/adapter` export `upgradeWebSocket` and `upgradeResponse`; a framework app imports `upgradeWebSocket` from `fetchlet/runtime/handler`, which does not install the profile again in an intermediate framework build. `fetchlet/hono/websocket` is Hono's WebSocket helper. The Nitro preset serves `defineWebSocketHandler` routes with `experimental.websocket` through crossws's Deno adapter. The Qwik City middleware completes upgrades that endpoints `send`. The Hono build keeps `fetchlet/runtime` out of its intermediate bundle, so an app that imports it installs the profile once.
