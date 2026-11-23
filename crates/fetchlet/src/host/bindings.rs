use std::collections::BTreeMap;
use std::sync::Arc;

use super::FetchService;
use super::channel::ChannelService;
use super::console::{ConsoleLevel, ConsoleSink};
use crate::{Error, Result};

/// Fixed bindings and services for one App. No process environment is inherited.
#[derive(Clone, Default)]
pub struct HostServices {
    pub(crate) outbound: Option<FetchService>,
    pub(crate) services: BTreeMap<String, FetchService>,
    pub(crate) channels: BTreeMap<String, Arc<dyn ChannelService>>,
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
        let name = self.unbound(name.into())?;
        self.services.insert(name, service);
        Ok(self)
    }

    /// Bind a channel service under `name` in `env`. JavaScript opens a
    /// channel with `env.NAME.connect(options)`; the channel belongs to that
    /// invocation and closes when it ends.
    pub fn channel(
        mut self,
        name: impl Into<String>,
        service: impl ChannelService,
    ) -> Result<Self> {
        let name = self.unbound(name.into())?;
        self.channels.insert(name, Arc::new(service));
        Ok(self)
    }

    /// `name`, if no binding has it yet: env values, services and channels
    /// share one namespace.
    fn unbound(&self, name: String) -> Result<String> {
        if self.services.contains_key(&name)
            || self.env.contains_key(&name)
            || self.channels.contains_key(&name)
        {
            return Err(Error::Configuration("duplicate binding".into()));
        }
        Ok(name)
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
        let name = self.unbound(name.into())?;
        let value = value.into();
        self.env.insert(name, value);
        Ok(self)
    }
}
