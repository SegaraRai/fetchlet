/// Native worker settings for a V8 isolate.
#[derive(Debug, Clone, Copy, Default)]
pub struct V8Options {
    /// None uses the platform's thread-stack setting.
    pub worker_stack_bytes: Option<usize>,
}

impl V8Options {
    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.worker_stack_bytes == Some(0) {
            return Err(crate::Error::Configuration(
                "engine resource sizes must be positive".into(),
            ));
        }
        Ok(())
    }
}
