/// Engine selection and its engine-specific configuration.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub enum Backend {
    #[cfg(feature = "boa")]
    Boa(super::BoaOptions),
    #[cfg(feature = "quickjs")]
    QuickJs(super::QuickJsOptions),
    #[cfg(feature = "v8")]
    V8(super::V8Options),
}

impl Backend {
    #[cfg(feature = "boa")]
    pub fn boa() -> Self {
        Self::Boa(super::BoaOptions::default())
    }

    #[cfg(feature = "quickjs")]
    pub fn quickjs() -> Self {
        Self::QuickJs(super::QuickJsOptions::default())
    }

    #[cfg(feature = "v8")]
    pub fn v8() -> Self {
        Self::V8(super::V8Options::default())
    }
}

impl Backend {
    pub(crate) fn validate(&self) -> crate::Result<()> {
        match self {
            #[cfg(feature = "boa")]
            Self::Boa(options) => options.validate(),
            #[cfg(feature = "quickjs")]
            Self::QuickJs(options) => options.validate(),
            #[cfg(feature = "v8")]
            Self::V8(options) => options.validate(),
        }
    }
}
