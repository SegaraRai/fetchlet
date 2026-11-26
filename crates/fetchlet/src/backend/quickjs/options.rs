/// QuickJS resource settings. None uses the engine's own setting. The heap
/// budget is `Limits::heap_bytes`, which every engine that can enforce one
/// shares.

#[derive(Debug, Clone, Copy, Default)]
pub struct QuickJsOptions {
    pub stack_limit_bytes: Option<usize>,
}

impl QuickJsOptions {
    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.stack_limit_bytes == Some(0) {
            return Err(crate::Error::Configuration(
                "engine resource sizes must be positive".into(),
            ));
        }
        Ok(())
    }
}
