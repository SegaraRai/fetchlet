use std::num::NonZeroUsize;
use std::time::Duration;

/// Configuration of the threads that own a shared application.
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
    /// How many instances serve the queue. One by default.
    pub instances: Instances,
}

/// The instances of an [`AppHandle`](crate::AppHandle), each on its own
/// worker thread and each running one call at a time.
///
/// Every instance is built from the same module, host services and limits.
/// Instances share no JavaScript state: module-level state exists once per
/// instance. Commands wait in one queue and go to whichever instance is free.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Instances {
    /// Instances built at spawn and kept while idle. A retired instance is
    /// rebuilt after the call that retired it, before its worker takes the
    /// next command.
    pub min: NonZeroUsize,
    /// The most instances the pool runs. A caller budget: each instance holds
    /// its own engine heap, so `max` times the heap configured in the engine
    /// options bounds the pool's JavaScript memory. When every instance is
    /// busy and fewer than `max` exist, a queued command starts another.
    pub max: NonZeroUsize,
    /// How long an instance above `min` stays idle before it retires. None
    /// keeps every instance the pool started.
    pub idle_timeout: Option<Duration>,
}

impl Instances {
    /// Exactly `count` instances, all built at spawn.
    pub fn fixed(count: NonZeroUsize) -> Self {
        Self {
            min: count,
            max: count,
            idle_timeout: None,
        }
    }
}

impl Default for Instances {
    fn default() -> Self {
        Self::fixed(NonZeroUsize::MIN)
    }
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
            instances: Instances::default(),
        }
    }
}
