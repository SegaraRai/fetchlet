mod adapter;
mod body;
mod types;

pub use adapter::FetchApp;
pub use body::Body;
pub use types::{Request, Response};

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing"
))]
pub(crate) use body::BodySender;
