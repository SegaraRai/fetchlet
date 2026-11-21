use std::num::NonZeroUsize;

/// Configuration of the thread that owns a shared application.
#[derive(Debug, Clone)]
pub struct WorkerOptions {
    /// Commands waiting behind the currently executing call.
    pub queue_capacity: NonZeroUsize,
    /// An explicit native thread stack size. None uses the platform setting.
    pub stack_size_bytes: Option<NonZeroUsize>,
    /// Response body messages buffered ahead of the consumer.
    ///
    /// The worker pulls the next chunk from JavaScript only when the queue has
    /// room, so this sets how far production runs ahead of the HTTP client.
    /// The default of one keeps production demand-driven.
    pub response_body_queue: NonZeroUsize,
    /// What the worker does with a call whose caller goes away while it
    /// runs. [`CancelledCalls::Retire`] by default.
    pub cancelled_calls: CancelledCalls,
}

/// What the worker does with a call or Fetch request whose caller goes away
/// while JavaScript runs it, such as a request the HTTP client cancels.
///
/// A call that has not started is skipped under either policy, and a
/// response body the caller drops between two reads is cancelled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CancelledCalls {
    /// Abandon the evaluation in progress and build a new instance before the
    /// next call, so that nothing of the call runs again. The worker is free
    /// at once.
    #[default]
    Retire,
    /// Let the evaluation in progress return, within the invocation
    /// deadline, then cancel the response body and keep the instance. The
    /// call ends in its own invocation scope, so nothing of it reaches the
    /// next call; one that leaves host fetches pending, or runs past the
    /// deadline, retires the instance as under `Retire`. The worker stays
    /// busy until then.
    ///
    /// For development hosts, whose instances are expensive to build: under
    /// a Vite dev server, a new instance fetches and evaluates every module
    /// again.
    Finish,
}

impl WorkerOptions {
    pub fn new(queue_capacity: NonZeroUsize) -> Self {
        Self {
            queue_capacity,
            stack_size_bytes: None,
            response_body_queue: NonZeroUsize::MIN,
            cancelled_calls: CancelledCalls::Retire,
        }
    }
}
