mod body_source;
mod channels;
mod clock;
mod dispatcher;
mod handles;

#[cfg(feature = "fuzzing")]
mod harness;

pub(crate) use dispatcher::HostBridge;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) use dispatcher::Disconnect;
#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing"
))]
pub(crate) use dispatcher::InvocationScope;
#[cfg(feature = "fuzzing")]
pub use harness::{BodyFeed, BridgeHarness, ChannelFeed};

#[cfg(test)]
mod tests;
