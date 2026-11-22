---
"@fetchlet-crates/fetchlet": minor
---

Fetch handlers can accept server WebSockets. `Instances::max_held_connections` (default 0, below `max`) bounds the instances that connections hold; a caller takes a place with `AppHandle::reserve_connection` and puts the `HeldConnection` in the request's extensions. An accepted upgrade returns a 101 with a `ServerWebSocket` extension whose `ChannelEnd` sends and receives the socket's messages, while the invocation and its instance stay held until the connection closes. `Limits` gains `channel_message_bytes`, `channel_buffer_bytes`, `connection_idle_timeout` and `connection_lifetime`, and shutdown closes held connections with 1001. `Instances` has the new field, so struct literals need `max_held_connections` or `..Instances::fixed(n)`.
