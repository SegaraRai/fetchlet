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
}

impl WorkerOptions {
    pub fn new(queue_capacity: NonZeroUsize) -> Self {
        Self {
            queue_capacity,
            stack_size_bytes: None,
            response_body_queue: NonZeroUsize::MIN,
        }
    }
}
