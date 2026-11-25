mod instance;
mod timeout;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod interrupt;
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

#[cfg(any(feature = "quickjs", feature = "v8"))]
pub(crate) use interrupt::StopReason;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) use interrupt::{Interrupt, Interrupted};
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
#[cfg(any(feature = "boa", feature = "quickjs"))]
pub(crate) use script::STACK_TRACE;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub(crate) use script::{
    BACKGROUND_SETTLE, FLUSH_REJECTIONS, HOST_BOOTSTRAP, LOOP_STEP, PRELUDE, ResponseBodyOperation,
    SEAL_HOST, connection_invocation, fetch_invocation, invocation, observed, placed_invocation,
    response_body_operation,
};

#[cfg(test)]
mod tests;
