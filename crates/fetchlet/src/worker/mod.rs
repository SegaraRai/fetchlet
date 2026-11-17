mod handle;
mod lifecycle;
mod options;
mod protocol;

// Only an engine runs the worker thread; the handle and its options are
// engine-independent so HTTP integrations can depend on them alone.
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod runtime;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod streaming;

pub use handle::AppHandle;
pub use options::WorkerOptions;
