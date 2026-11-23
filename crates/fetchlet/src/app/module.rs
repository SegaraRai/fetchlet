use std::sync::Arc;

use crate::Requirements;

/// A prebuilt script exposing named functions through `fetchletExports`,
/// with what it needs from the host that runs it.
#[derive(Debug, Clone)]
pub struct Module {
    source: Arc<str>,
    requirements: Requirements,
}

impl Module {
    pub fn new(source: impl Into<Arc<str>>) -> Self {
        Self {
            source: source.into(),
            requirements: Requirements::new(),
        }
    }

    /// Check `requirements` against the engine before the module is
    /// evaluated, so a host that lacks one refuses to build the App.
    pub fn requires(mut self, requirements: Requirements) -> Self {
        self.requirements = requirements;
        self
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn requirements(&self) -> &Requirements {
        &self.requirements
    }
}
