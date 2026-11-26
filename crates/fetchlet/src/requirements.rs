use std::collections::BTreeSet;

/// What a module needs from the host that runs it, as `fetchlet/build`
/// records in an artifact's manifest: native engine APIs and the locales
/// they must support, the engine's async context, and the Web APIs and
/// protocol of fetchlet-web.
///
/// ```ignore
/// let requirements = Requirements::new()
///     .engine_api("Intl.DateTimeFormat")
///     .locales(["en", "ja"])
///     .host_api("crypto");
/// let app = App::builder(backend)
///     .module(Module::new(source).requires(requirements))
///     .build()?;
/// ```
///
/// Building an App checks them against its engine before the module is
/// evaluated, and fails with `Error::Configuration` naming every one that
/// is missing. Requirements are names, so a name this host does not know
/// counts as missing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Requirements {
    engine_apis: BTreeSet<String>,
    locales: Vec<String>,
    async_context: bool,
    host_apis: BTreeSet<String>,
    host_protocol: Option<u32>,
    preemption: bool,
}

impl Requirements {
    pub fn new() -> Self {
        Self::default()
    }

    /// A global the engine itself must provide, by its path from
    /// `globalThis`, such as `Intl.DateTimeFormat` or `WebAssembly`.
    pub fn engine_api(mut self, api: impl Into<String>) -> Self {
        self.engine_apis.insert(api.into());
        self
    }

    /// Locales that each engine API with `supportedLocalesOf`, such as the
    /// Intl constructors, must support.
    pub fn locales<I, S>(mut self, locales: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for locale in locales {
            let locale = locale.into();
            if !self.locales.contains(&locale) {
                self.locales.push(locale);
            }
        }
        self
    }

    /// The engine's async context slot, which `AsyncLocalStorage` in
    /// `asyncContext: "propagated"` builds needs.
    pub fn async_context(mut self) -> Self {
        self.async_context = true;
        self
    }

    /// A Web API that fetchlet-web serves, by the name its
    /// `web.capabilities` operation reports, such as `crypto` or
    /// `compression`.
    pub fn host_api(mut self, api: impl Into<String>) -> Self {
        self.host_apis.insert(api.into());
        self
    }

    /// The fetchlet-web protocol version that the module's Web API profile
    /// speaks.
    pub fn host_protocol(mut self, version: u32) -> Self {
        self.host_protocol = Some(version);
        self
    }

    /// That the engine stops JavaScript that never yields wherever it
    /// runs, when the deadline, busy timeout or startup timeout passes or
    /// the call is cancelled. Builds do not record it: an embedder that
    /// runs code it does not trust adds it to the module's requirements.
    /// QuickJS meets it, and V8 with `V8Options::reliable_termination`; Boa
    /// stops JavaScript only at its promise jobs and host calls, so it does
    /// not.
    pub fn preemption(mut self) -> Self {
        self.preemption = true;
        self
    }

    pub fn is_empty(&self) -> bool {
        self.engine_apis.is_empty()
            && !self.async_context
            && !self.preemption
            && self.host_apis.is_empty()
            && self.host_protocol.is_none()
    }
}

/// What the startup check reads; without an engine nothing checks.
#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    allow(dead_code)
)]
impl Requirements {
    pub(crate) fn engine_apis(&self) -> impl Iterator<Item = &str> {
        self.engine_apis.iter().map(String::as_str)
    }

    pub(crate) fn locale_list(&self) -> &[String] {
        &self.locales
    }

    pub(crate) fn needs_async_context(&self) -> bool {
        self.async_context
    }

    pub(crate) fn needs_preemption(&self) -> bool {
        self.preemption
    }

    pub(crate) fn host_apis(&self) -> impl Iterator<Item = &str> {
        self.host_apis.iter().map(String::as_str)
    }

    pub(crate) fn protocol(&self) -> Option<u32> {
        self.host_protocol
    }
}
