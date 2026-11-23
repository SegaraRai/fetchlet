use std::time::Instant;

use bytes::{Bytes, BytesMut};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use super::AppBuilder;
use super::connection::OpenConnection;
use super::response_body::OpenResponseBody;
use crate::backend::Engine;
use crate::bridge::{Disconnect, HostBridge, InvocationScope};
use crate::config::check_limit;
use crate::execution::{
    BACKGROUND_SETTLE, deadline_after, fetch_invocation, placed_invocation, with_deadline,
};
use crate::host::GuestEnd;
use crate::placed::{ByteLayout, Placed};
use crate::wire::{WireRequest, WireResponse};
use crate::{
    Backend, Body, Call, CallOutput, Context, Error, HeldConnection, HostServices, Instance,
    Limits, Request, Response, Result, ServerWebSocket,
};

/// What `invokeExport` returns for a call: the result's JSON, with `null`
/// at each byte array, and the layout of their bytes.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CallResult {
    value: Value,
    #[serde(default)]
    bytes: Option<ByteLayout>,
}

/// What a Fetch invocation leaves open after its response head.
pub(crate) enum Opened {
    /// A JavaScript body that the caller pulls.
    Body(OpenResponseBody),
    /// An accepted connection, held until it closes.
    Connection(OpenConnection),
}

/// A managed, reusable application instance with fixed host bindings.
///
/// Calls are exclusive (`&mut self`). Keep an App on its owning thread; pool or
/// worker scheduling is left to the Rust application in this release.
/// `App::fetch` returns a buffered body; `AppHandle::fetch` streams it.
pub struct App {
    pub(super) engine: Engine,
    pub(super) host: HostBridge,
    pub(super) limits: Limits,
    pub(super) handler: Option<String>,
    pub(super) reusable: bool,
    /// An ended invocation whose `fetchlet.waitUntil` work has not settled.
    pub(super) background: Option<PendingBackground>,
}

/// The open scope of background work and its deadline.
pub(super) struct PendingBackground {
    scope: InvocationScope,
    deadline: Option<Instant>,
}

impl App {
    pub fn builder(backend: Backend) -> AppBuilder {
        AppBuilder {
            backend,
            module: None,
            hosts: HostServices::default(),
            limits: Limits::default(),
            handler: Some("handle".into()),
            key: None,
            host_runtime: None,
        }
    }

    /// The budgets of each invocation, which channels lent with [`Call`]
    /// take too.
    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    pub fn is_reusable(&self) -> bool {
        self.reusable && self.engine.is_reusable()
    }

    /// Whether background work registered by an earlier call is still open.
    pub fn has_background(&self) -> bool {
        self.background.is_some()
    }

    /// Run background work registered with `fetchlet.waitUntil` to completion.
    ///
    /// A call or Fetch response ends before its background work. That work
    /// keeps the invocation's host scope and timers, and runs here within
    /// `Limits::background_timeout`, counted from the end of the result or
    /// body. The next call runs it first if the caller has not. Work that
    /// cannot settle in time retires the instance with `DeadlineExceeded`.
    pub async fn finish_background(&mut self) -> Result<()> {
        let Some(background) = self.background.take() else {
            return Ok(());
        };
        let result = self
            .evaluate(BACKGROUND_SETTLE.to_owned(), background.deadline)
            .await;
        // Settled work leaves nothing behind; anything left retires the instance.
        if background.scope.has_pending() || background.scope.has_background() {
            self.reusable = false;
        }
        drop(background.scope);
        result.map(drop)
    }

    pub async fn call_json(&mut self, export: &str, args: &[Value]) -> Result<Value> {
        let call = Call::with_arguments(export.to_owned(), args.to_vec());
        Ok(self.call_with(call).await?.into_value())
    }

    /// Call a function with the arguments and context of `call`.
    pub async fn call_with(&mut self, call: Call) -> Result<CallOutput> {
        self.finish_background().await?;
        let parts = call.into_parts();
        let scope = self.begin(parts.context)?;
        let result = self
            .run_call(parts.export, parts.arguments, parts.bytes, parts.channels)
            .await;
        self.close(scope);
        result
    }

    async fn run_call(
        &mut self,
        export: String,
        arguments: Vec<Value>,
        bytes: Placed<Bytes>,
        channels: Placed<GuestEnd>,
    ) -> Result<CallOutput> {
        let mut byte_handles = Vec::with_capacity(bytes.len());
        for (path, bytes) in bytes {
            byte_handles.push((path, self.host.put_bytes(bytes)?));
        }
        let mut channel_handles = Vec::with_capacity(channels.len());
        for (path, end) in channels {
            channel_handles.push((path, self.host.lend_channel(end)?));
        }
        let expression = placed_invocation(&export, &arguments, &byte_handles, &channel_handles)
            .map_err(invalid_request)?;
        let result = self
            .evaluate(expression, deadline_after(self.limits.timeout))
            .await?;
        let CallResult { mut value, bytes } = serde_json::from_value(result)
            .map_err(|error| Error::JavaScript(format!("invalid call result: {error}")))?;
        let placed = match bytes {
            Some(layout) => {
                let buffer = self.host.take_bytes(layout.handle())?;
                layout.split(&mut value, buffer, true)?
            }
            None => Vec::new(),
        };
        Ok(CallOutput::new(value, placed))
    }

    /// Call a named function with one Serde argument and deserialize its result.
    pub async fn call<I: Serialize + ?Sized, O: DeserializeOwned>(
        &mut self,
        export: &str,
        input: &I,
    ) -> Result<O> {
        let input = serde_json::to_value(input).map_err(invalid_request)?;
        let call = Call::with_arguments(export.to_owned(), vec![input]);
        self.call_with(call).await?.deserialize()
    }

    /// Run the Fetch handler and collect the complete response body.
    pub async fn fetch(&mut self, request: Request) -> Result<Response> {
        self.fetch_buffered(request, None).await
    }

    /// Pass request-scoped metadata as the Fetch entry's second argument.
    pub async fn fetch_with_context<C: Serialize + ?Sized>(
        &mut self,
        request: Request,
        context: &C,
    ) -> Result<Response> {
        let context = serde_json::to_value(context).map_err(invalid_request)?;
        self.fetch_buffered(request, Some(context)).await
    }

    async fn fetch_buffered(
        &mut self,
        request: Request,
        context: Option<Value>,
    ) -> Result<Response> {
        let (response, open) = self.fetch_head(request, context, None, false).await?;
        let mut open = match open {
            None => return Ok(response),
            Some(Opened::Body(open)) => open,
            // Not offered without `hold`.
            Some(Opened::Connection(open)) => {
                self.close(open.into_scope());
                return Err(Error::InvalidRequest("unexpected upgrade".into()));
            }
        };
        let (parts, body) = response.into_parts();
        let mut data = BytesMut::from(body.buffered()?);
        loop {
            let pulled = self.pull_response_body(open).await?;
            data.extend_from_slice(&pulled.chunk);
            match pulled.next {
                Some(next) => open = next,
                None => return Ok(Response::from_parts(parts, Body::from(data.freeze()))),
            }
        }
    }

    /// Run the Fetch handler until its response head is available.
    ///
    /// The returned body holds the bytes produced so far. When the JavaScript
    /// body is still open, the invocation stays open with it: the caller must
    /// pull it to the end or cancel it before the App runs another call.
    /// `disconnect`, when given, aborts the request's signal in JavaScript
    /// once signalled, for the head and every pull of the body.
    ///
    /// With `hold`, a WebSocket upgrade request that carries a
    /// [`HeldConnection`] may be accepted; the response then has status 101
    /// and a [`ServerWebSocket`], and the caller runs the connection with
    /// [`App::hold_connection`].
    pub(crate) async fn fetch_head(
        &mut self,
        request: Request,
        context: Option<Value>,
        disconnect: Option<Disconnect>,
        hold: bool,
    ) -> Result<(Response, Option<Opened>)> {
        if self.handler.is_none() {
            return Err(Error::Configuration(
                "the application has no Fetch handler".into(),
            ));
        }
        self.finish_background().await?;
        if !self.is_reusable() {
            return Err(Error::InstanceUnavailable);
        }
        let deadline = deadline_after(self.limits.timeout);
        // A trusted Context stays in Rust; JavaScript receives the wire request.
        let mut request = request;
        let trusted = request.extensions_mut().remove::<Context>();
        let held = request
            .extensions_mut()
            .remove::<HeldConnection>()
            .filter(|_| hold && is_websocket_upgrade(&request));
        // The request body goes into this invocation's byte store.
        let scope = self.begin(trusted)?;
        if let Some(disconnect) = disconnect
            && let Err(error) = self.host.watch_disconnect(disconnect)
        {
            self.close(scope);
            return Err(error);
        }
        if held.is_some()
            && let Err(error) = self.host.allow_upgrade()
        {
            self.close(scope);
            return Err(error);
        }
        let expression = match self.fetch_expression(request, context, deadline).await {
            Ok(expression) => expression,
            Err(error) => {
                self.close(scope);
                return Err(error);
            }
        };
        let value = match self.evaluate(expression, deadline).await {
            Ok(value) => value,
            Err(error) => {
                self.close(scope);
                return Err(error);
            }
        };
        let wire: WireResponse = match serde_json::from_value(value) {
            Ok(wire) => wire,
            Err(error) => {
                // A malformed result may have left a JavaScript body open.
                self.reusable = false;
                self.close(scope);
                return Err(Error::JavaScript(format!(
                    "invalid Fetch response: {error}"
                )));
            }
        };
        let stream = wire.stream;
        let upgrade = wire.upgrade;
        let mut response = match wire.into_http(&self.limits, &mut self.host) {
            Ok(response) => response,
            Err(error) => {
                match stream {
                    Some(id) => {
                        let open = OpenResponseBody::new(id, scope, deadline, 0);
                        self.cancel_response_body(open).await;
                    }
                    None => self.close(scope),
                }
                return Err(error);
            }
        };
        if let Some(channel) = upgrade {
            let (held, end) = match (held, self.host.take_upgrade(channel)) {
                (Some(held), Ok(end)) => (held, end),
                (_, result) => {
                    self.close(scope);
                    return Err(result
                        .err()
                        .unwrap_or_else(|| Error::InvalidRequest("unexpected upgrade".into())));
                }
            };
            response.extensions_mut().insert(ServerWebSocket::new(end));
            let open = OpenConnection::new(channel, scope, held);
            return Ok((response, Some(Opened::Connection(open))));
        }
        match stream {
            None => {
                self.close(scope);
                Ok((response, None))
            }
            Some(id) => {
                let received = response.body().buffered()?.len();
                let open = OpenResponseBody::new(id, scope, deadline, received);
                Ok((response, Some(Opened::Body(open))))
            }
        }
    }

    async fn fetch_expression(
        &mut self,
        request: Request,
        context: Option<Value>,
        deadline: Option<Instant>,
    ) -> Result<String> {
        let input = with_deadline(
            deadline,
            WireRequest::from_http(request, &self.limits, &mut self.host),
        )
        .await??;
        let mut arguments = vec![serde_json::to_value(input).map_err(invalid_request)?];
        arguments.extend(context);
        let handler = self.handler.as_deref().unwrap_or_default();
        fetch_invocation(handler, &arguments).map_err(invalid_request)
    }

    /// A disconnect token for the next Fetch call; see [`App::fetch_head`].
    pub(crate) fn disconnect(&self) -> Disconnect {
        self.host.disconnect()
    }

    pub(super) fn begin(&mut self, context: Option<Context>) -> Result<InvocationScope> {
        if !self.is_reusable() {
            return Err(Error::InstanceUnavailable);
        }
        self.host.begin_with_context(self.limits.clone(), context)
    }

    /// Run one engine evaluation within the invocation deadline.
    pub(super) async fn evaluate(
        &mut self,
        expression: String,
        deadline: Option<Instant>,
    ) -> Result<Value> {
        // This remains false if the caller drops the future at any await point.
        self.reusable = false;
        let result = with_deadline(deadline, self.engine.evaluate(expression)).await;
        self.reusable = result.is_ok() && self.engine.is_reusable();
        result?.map_err(|error| Error::JavaScript(error.to_string()))
    }

    /// End an invocation's result or body. Background work keeps the scope
    /// open for [`App::finish_background`]; otherwise unfinished host
    /// operations retire the instance.
    pub(super) fn close(&mut self, scope: InvocationScope) {
        if self.reusable && scope.has_background() {
            self.background = Some(PendingBackground {
                scope,
                deadline: deadline_after(self.limits.background_timeout),
            });
            return;
        }
        if scope.has_pending() {
            self.reusable = false;
        }
        drop(scope);
    }

    pub(super) fn check_response_bytes(&self, received: usize) -> Result<()> {
        check_limit(
            self.limits.response_body_bytes,
            received,
            "response body bytes",
        )
    }
}

/// A WebSocket opening handshake request (RFC 6455 §4.2.1): a GET that asks
/// to upgrade to `websocket`. The HTTP integration checks the rest of the
/// handshake before it answers.
fn is_websocket_upgrade(request: &Request) -> bool {
    request.method() == http::Method::GET
        && request
            .headers()
            .get_all(http::header::UPGRADE)
            .iter()
            .any(|value| {
                value.to_str().is_ok_and(|value| {
                    value
                        .split(',')
                        .any(|token| token.trim().eq_ignore_ascii_case("websocket"))
                })
            })
}

fn invalid_request(error: impl std::fmt::Display) -> Error {
    Error::InvalidRequest(error.to_string())
}
