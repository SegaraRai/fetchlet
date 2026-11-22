---
"@fetchlet/web": minor
---

`upgradeWebSocket` takes `headers` for the 101 response, whose `Sec-WebSocket-Protocol` selects the subprotocol when `protocol` is not given. `upgradeResponse(headers)` rebuilds the upgrade response of the socket the current invocation accepted, for frameworks that copy responses. The upgrade response is recognized under a registered symbol, so it reaches the host when a framework bundles another copy of the module.
