// The channels of env bindings in the fetchlet App host, which Rust
// ChannelServices open: their binding, views and close.

export type { ChannelBinding, ChannelClose, HostChannel } from "./internal/channels/host-channel";
export type { ChannelStream } from "./internal/channels/stream-view";
