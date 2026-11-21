mod body_source;
mod clock;
mod dispatcher;

#[cfg(feature = "fuzzing")]
mod harness;

pub(crate) use dispatcher::{Disconnect, HostBridge};

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing"
))]
pub(crate) use dispatcher::InvocationScope;
#[cfg(feature = "fuzzing")]
pub use harness::{BodyFeed, BridgeHarness};

#[cfg(test)]
mod tests;
