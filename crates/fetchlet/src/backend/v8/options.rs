/// The smallest `heap_limit_bytes` accepted: underlying capacity. V8 and
/// deno_core's bootstrap fill about 8 MiB of heap while the isolate is
/// created, before the near-heap-limit callback that turns exhaustion into
/// an error is installed, and V8 ends the process when that runs out. Twice
/// that leaves room for changes between V8 versions.
pub const MIN_V8_HEAP_LIMIT_BYTES: usize = 16 << 20;

/// Native worker and memory settings for a V8 isolate.
#[derive(Debug, Clone, Copy, Default)]
pub struct V8Options {
    /// None uses the platform's thread-stack setting.
    pub worker_stack_bytes: Option<usize>,
    /// The isolate's managed heap, a caller budget, at least
    /// [`MIN_V8_HEAP_LIMIT_BYTES`]. Near it the isolate is stopped, the call
    /// fails with `LimitExceeded("engine heap")` and the instance retires;
    /// the isolate may briefly use a quarter more, at least 8 MiB, to
    /// unwind. None keeps V8's own limit, whose exhaustion ends the process.
    pub heap_limit_bytes: Option<usize>,
    /// The bytes of `ArrayBuffer` storage, which lives outside the managed
    /// heap, a caller budget. An allocation past it throws a `RangeError`.
    /// None uses `heap_limit_bytes`, and without either it is unlimited.
    pub array_buffer_limit_bytes: Option<usize>,
    /// Compile on-stack replacement code on the isolate's own thread
    /// (V8's `--no-concurrent-osr`), so that the time limits and the heap
    /// limit stop every loop. Without it, V8 does not stop some hot loops
    /// that allocate, such as one around `new Array(1000).fill(0)`, until
    /// they return. Off by default: it trades some optimizing work on the
    /// request's thread for that guarantee, which matters only to code that
    /// may never return.
    ///
    /// The flag is process-wide and V8 reads it once, so it applies to every
    /// V8 instance when the first one fetchlet starts in the process sets
    /// it; setting it on a later one fails with `Error::Configuration`. An
    /// embedder that initializes V8 itself passes `--no-concurrent-osr`
    /// instead.
    pub reliable_termination: bool,
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
        if self
            .heap_limit_bytes
            .is_some_and(|bytes| bytes < MIN_V8_HEAP_LIMIT_BYTES)
        {
            return Err(crate::Error::Configuration(format!(
                "V8Options::heap_limit_bytes must be at least {} MiB",
                MIN_V8_HEAP_LIMIT_BYTES >> 20
            )));
        }
        Ok(())
    }
}
