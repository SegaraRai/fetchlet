mod instance;
mod timeout;

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8", test))]
mod scheduler;
#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
mod script;

pub use instance::Instance;
pub(crate) use timeout::with_timeout;

#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
pub(crate) use scheduler::LoopState;
#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8", test))]
pub(crate) use scheduler::WakeSignal;
#[cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]
pub(crate) use script::{HOST_BOOTSTRAP, LOOP_STEP, PRELUDE, invocation};

#[cfg(test)]
mod tests;
