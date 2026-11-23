---
"@fetchlet-crates/fetchlet": minor
---

`ChannelEnd` implements `Stream` of `ChannelEvent` and `Sink` of `Message`, so `futures` combinators such as `send_all`, `forward` and `split` work on it. The sink holds one message while it waits for room in `Limits::channel_buffer_bytes`; a `send` dropped while it waits keeps its message, which goes out before the next one, and closing the sink flushes it and closes with 1000.
