mod instance;
mod timeout;

#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
mod scheduler;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod script;

pub use instance::Instance;
pub(crate) use timeout::with_timeout;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) use timeout::{deadline_after, with_deadline};

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) use scheduler::LoopState;
#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
pub(crate) use scheduler::WakeSignal;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) use script::{
    BACKGROUND_SETTLE, FLUSH_REJECTIONS, HOST_BOOTSTRAP, LOOP_STEP, PRELUDE, ResponseBodyOperation,
    SEAL_HOST, fetch_invocation, invocation, observed, response_body_operation,
};

#[cfg(test)]
mod tests;
