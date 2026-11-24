/// Native worker and memory settings for a V8 isolate.
#[derive(Debug, Clone, Copy, Default)]
pub struct V8Options {
    /// None uses the platform's thread-stack setting.
    pub worker_stack_bytes: Option<usize>,
    /// The isolate's managed heap, a caller budget. Near it the isolate is
    /// stopped, the call fails with `LimitExceeded("engine heap")` and the
    /// instance retires; the isolate may briefly use a quarter more, at
    /// least 8 MiB, to unwind. None keeps V8's own limit, whose exhaustion
    /// ends the process.
    pub heap_limit_bytes: Option<usize>,
    /// The bytes of `ArrayBuffer` storage, which lives outside the managed
    /// heap, a caller budget. An allocation past it throws a `RangeError`.
    /// None uses `heap_limit_bytes`, and without either it is unlimited.
    pub array_buffer_limit_bytes: Option<usize>,
}

impl V8Options {
    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.worker_stack_bytes == Some(0)
            || self.heap_limit_bytes == Some(0)
            || self.array_buffer_limit_bytes == Some(0)
        {
            return Err(crate::Error::Configuration(
                "engine resource sizes must be positive".into(),
            ));
        }
        Ok(())
    }
}
