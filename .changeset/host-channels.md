---
"@fetchlet-crates/fetchlet": minor
"@fetchlet/web": minor
"fetchlet": minor
---

Open request-scoped channels to Rust services. `HostServices::channel(name, service)` binds a `ChannelService`, which `channel_fn` adapts from an async function, and `Limits::open_channels` bounds the opens of one invocation. JavaScript opens a channel with `env.NAME.connect(options)` and takes a WebSocket view with `socket()` or a byte stream view with `stream()`; the channel closes when its invocation ends. `fetchlet/bindings` types the binding as `ChannelBinding`.
