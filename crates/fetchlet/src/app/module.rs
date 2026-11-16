use std::sync::Arc;

/// A prebuilt script exposing named functions through `fetchletExports`.
#[derive(Debug, Clone)]
pub struct Module {
    source: Arc<str>,
}

impl Module {
    pub fn new(source: impl Into<Arc<str>>) -> Self {
        Self {
            source: source.into(),
        }
    }

    pub fn source(&self) -> &str {
        &self.source
    }
}
