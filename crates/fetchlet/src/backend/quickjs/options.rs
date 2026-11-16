/// QuickJS resource settings. None uses the engine's own setting.

#[derive(Debug, Clone, Copy, Default)]
pub struct QuickJsOptions {
    pub memory_limit_bytes: Option<usize>,
    pub stack_limit_bytes: Option<usize>,
}

impl QuickJsOptions {
    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.memory_limit_bytes == Some(0) || self.stack_limit_bytes == Some(0) {
            return Err(crate::Error::Configuration(
                "engine resource sizes must be positive".into(),
            ));
        }
        Ok(())
    }
}
