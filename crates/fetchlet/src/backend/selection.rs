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

    /// The engine for an artifact built for `target`, the `backend` that
    /// `fetchlet/build` records in its manifest: `quickjs`, `boa` or `v8`,
    /// or `portable`, which runs on any engine and selects the first enabled
    /// one of QuickJS, Boa and V8. Fails with a message naming the Cargo
    /// feature when the target's engine is not enabled.
    pub fn for_target(target: &str) -> crate::Result<Self> {
        match target {
            "quickjs" => {
                #[cfg(feature = "quickjs")]
                return Ok(Self::quickjs());
                #[cfg(not(feature = "quickjs"))]
                return Err(missing_engine("quickjs"));
            }
            "boa" => {
                #[cfg(feature = "boa")]
                return Ok(Self::boa());
                #[cfg(not(feature = "boa"))]
                return Err(missing_engine("boa"));
            }
            "v8" => {
                #[cfg(feature = "v8")]
                return Ok(Self::v8());
                #[cfg(not(feature = "v8"))]
                return Err(missing_engine("v8"));
            }
            "portable" => {
                #[cfg(feature = "quickjs")]
                return Ok(Self::quickjs());
                #[cfg(all(not(feature = "quickjs"), feature = "boa"))]
                return Ok(Self::boa());
                #[cfg(all(not(feature = "quickjs"), not(feature = "boa"), feature = "v8"))]
                return Ok(Self::v8());
                #[cfg(not(any(feature = "quickjs", feature = "boa", feature = "v8")))]
                return Err(crate::Error::Configuration(
                    "enable one of the fetchlet crate's `quickjs`, `boa` or `v8` features".into(),
                ));
            }
            other => Err(crate::Error::Configuration(format!(
                "unknown artifact backend {other:?}; expected quickjs, boa, v8 or portable"
            ))),
        }
    }

    /// Set QuickJS's stack limit to `bytes` when it has none; other engines
    /// are unchanged. The limit must stay below the native stack of the
    /// thread the engine runs on.
    #[cfg_attr(not(feature = "quickjs"), allow(unused_variables))]
    pub fn with_default_quickjs_stack(self, bytes: usize) -> Self {
        match self {
            #[cfg(feature = "quickjs")]
            Self::QuickJs(mut options) => {
                options.stack_limit_bytes.get_or_insert(bytes);
                Self::QuickJs(options)
            }
            #[allow(unreachable_patterns)]
            other => other,
        }
    }

    /// Set Boa's value stack limit to `slots` and its recursion limit to
    /// `depth` where it has none; other engines are unchanged. Both must fit
    /// the native stack of the thread the engine runs on.
    #[cfg_attr(not(feature = "boa"), allow(unused_variables))]
    pub fn with_default_boa_stack(self, slots: usize, depth: usize) -> Self {
        match self {
            #[cfg(feature = "boa")]
            Self::Boa(mut options) => {
                options.stack_size_limit.get_or_insert(slots);
                options.recursion_limit.get_or_insert(depth);
                Self::Boa(options)
            }
            #[allow(unreachable_patterns)]
            other => other,
        }
    }

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

/// The error for an artifact whose engine is not compiled in.
#[allow(dead_code)]
fn missing_engine(engine: &str) -> crate::Error {
    crate::Error::Configuration(format!(
        "the artifact targets {engine}; enable the fetchlet crate's `{engine}` feature to run it"
    ))
}

#[cfg(test)]
mod tests {
    use super::Backend;

    #[test]
    fn targets_select_their_engine_or_name_the_missing_feature() {
        #[cfg(feature = "quickjs")]
        assert!(matches!(
            Backend::for_target("quickjs"),
            Ok(Backend::QuickJs(_))
        ));
        #[cfg(feature = "quickjs")]
        assert!(matches!(
            Backend::for_target("portable"),
            Ok(Backend::QuickJs(_))
        ));
        #[cfg(feature = "boa")]
        assert!(matches!(Backend::for_target("boa"), Ok(Backend::Boa(_))));
        #[cfg(not(feature = "v8"))]
        assert!(
            Backend::for_target("v8")
                .unwrap_err()
                .to_string()
                .contains("`v8` feature")
        );
        assert!(Backend::for_target("spidermonkey").is_err());
        #[cfg(feature = "boa")]
        {
            let Backend::Boa(options) = Backend::boa().with_default_boa_stack(2048, 300) else {
                unreachable!()
            };
            assert_eq!(options.stack_size_limit, Some(2048));
            assert_eq!(options.recursion_limit, Some(300));
        }
        #[cfg(feature = "quickjs")]
        {
            let Backend::QuickJs(options) = Backend::quickjs().with_default_quickjs_stack(4096)
            else {
                unreachable!()
            };
            assert_eq!(options.stack_limit_bytes, Some(4096));
            let set = Backend::QuickJs(super::super::QuickJsOptions {
                stack_limit_bytes: Some(1024),
                ..Default::default()
            });
            let Backend::QuickJs(options) = set.with_default_quickjs_stack(4096) else {
                unreachable!()
            };
            assert_eq!(options.stack_limit_bytes, Some(1024));
        }
    }
}
