mod child;
#[cfg(target_os = "macos")]
mod footprint;
mod frame;
#[cfg(windows)]
mod job;
mod options;
mod parent;

pub use child::serve_if_child;
pub use options::{Isolation, ProcessOptions, Program};

#[cfg(feature = "fuzzing")]
pub use frame::fuzz_frames;

pub(crate) use child::RemoteLink;
pub(crate) use parent::{ProcessEnded, ProcessEngine};
