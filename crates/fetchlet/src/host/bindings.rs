use std::collections::BTreeMap;

use super::FetchService;
use super::console::{ConsoleLevel, ConsoleSink};
use crate::{Error, Result};

/// Fixed bindings and services for one App. No process environment is inherited.
#[derive(Clone, Default)]
pub struct HostServices {
    pub(crate) outbound: Option<FetchService>,
    pub(crate) services: BTreeMap<String, FetchService>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) console: Option<ConsoleSink>,
}

impl HostServices {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn outbound(mut self, service: FetchService) -> Self {
        self.outbound = Some(service);
        self
    }

    pub fn service(mut self, name: impl Into<String>, service: FetchService) -> Result<Self> {
        let name = name.into();
        if self.services.contains_key(&name) || self.env.contains_key(&name) {
            return Err(Error::Configuration("duplicate binding".into()));
        }
        self.services.insert(name, service);
        Ok(self)
    }

    /// Sends `console.debug`, `log`, `info`, `warn` and `error` of the App's
    /// JavaScript to `sink`. Without a sink, console output is discarded.
    /// Each message is one bridge message, so `Limits::bridge_message_bytes`
    /// bounds its size; a longer message arrives as a notice that it was dropped.
    pub fn console(mut self, sink: impl Fn(ConsoleLevel, &str) + Send + Sync + 'static) -> Self {
        self.console = Some(ConsoleSink::new(sink));
        self
    }

    pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Result<Self> {
        let name = name.into();
        if self.services.contains_key(&name) || self.env.contains_key(&name) {
            return Err(Error::Configuration("duplicate binding".into()));
        }
        let value = value.into();
        self.env.insert(name, value);
        Ok(self)
    }
}
