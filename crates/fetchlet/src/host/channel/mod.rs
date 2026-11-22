// JavaScript's end of a channel lives in the bridge, which only an engine,
// the fuzzing harness and the unit tests compile.
#[cfg_attr(
    not(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing",
        test
    )),
    allow(dead_code)
)]
mod end;
mod message;
#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    allow(dead_code)
)]
mod upgrade;

pub use end::{ChannelEnd, ChannelEvent};
pub use message::{CloseFrame, Message};
pub use upgrade::ServerWebSocket;

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
pub(crate) use end::{GuestEnd, Refused, pair};
