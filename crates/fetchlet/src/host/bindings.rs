use std::collections::BTreeMap;
use std::sync::Arc;

use super::FetchService;
use super::channel::ChannelService;
use super::console::{ConsoleLevel, ConsoleSink};
use super::function::Functions;
use super::socket::SocketService;
use super::websocket::WebSocketService;
use crate::{Error, Result};

/// Fixed bindings and services for one App. No process environment is inherited.
#[derive(Clone, Default)]
pub struct HostServices {
    pub(crate) outbound: Option<FetchService>,
    pub(crate) services: BTreeMap<String, FetchService>,
    pub(crate) channels: BTreeMap<String, Arc<dyn ChannelService>>,
    pub(crate) sockets: Option<SocketService>,
    pub(crate) websockets: Option<WebSocketService>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) functions: BTreeMap<String, Functions>,
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

    /// Serve `connect(address, options)` from `fetchlet/runtime`: each
    /// connection the service's policy allows opens through its transport,
    /// as a channel of the invocation. Without a socket service, `connect`
    /// fails with `PermissionDenied`.
    pub fn sockets(mut self, service: SocketService) -> Self {
        self.sockets = Some(service);
        self
    }

    /// Serve the global `WebSocket` of the Web API profile: each connection
    /// to an origin the service's policy allows opens through its
    /// transport, as a channel of the invocation. Without a WebSocket
    /// service, a `WebSocket` fails as a refused connection.
    pub fn websockets(mut self, service: WebSocketService) -> Self {
        self.websockets = Some(service);
        self
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

    /// Bind Rust functions under `name` in `env`. JavaScript calls each
    /// method as `env.NAME.method(...args)`; see [`Functions`] for how
    /// arguments, results and errors cross. A method named `then`, or one
    /// added twice, fails with `Configuration`.
    pub fn functions(mut self, name: impl Into<String>, functions: Functions) -> Result<Self> {
        functions.validate()?;
        let name = self.unbound(name.into())?;
        self.functions.insert(name, functions);
        Ok(self)
    }

    /// `name`, if no binding has it yet: env values, services, channels and
    /// functions share one namespace.
    fn unbound(&self, name: String) -> Result<String> {
        if self.services.contains_key(&name)
            || self.env.contains_key(&name)
            || self.channels.contains_key(&name)
            || self.functions.contains_key(&name)
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
