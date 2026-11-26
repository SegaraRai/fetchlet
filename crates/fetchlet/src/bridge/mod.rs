mod body_source;
mod channels;
mod clock;
mod dispatcher;
mod functions;
mod handles;
mod upload;

#[cfg(feature = "fuzzing")]
mod harness;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod guest_link;

pub(crate) use dispatcher::HostBridge;

#[cfg(fetchlet_process)]
pub(crate) use clock::Clock;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) use dispatcher::Disconnect;
#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing"
))]
pub(crate) use dispatcher::InvocationScope;
#[cfg(fetchlet_process)]
pub(crate) use dispatcher::encode_reply;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) use guest_link::GuestLink;

#[cfg(feature = "fuzzing")]
pub use harness::{
    BodyFeed, BridgeHarness, ChannelFeed, harness_channel_service, harness_socket_service,
    harness_websocket_service,
};

#[cfg(test)]
mod tests;
