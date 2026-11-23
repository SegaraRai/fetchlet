use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use super::ChannelEnd;
use crate::{Context, Result};

/// The future of an open: Ok once the channel is open, or the error that
/// refuses it.
pub type ChannelFuture = Pin<Box<dyn Future<Output = Result<()>> + Send + 'static>>;

/// A channel JavaScript asked a [`ChannelService`] to open, with
/// `env.NAME.connect(options)`.
#[non_exhaustive]
pub struct ChannelRequest {
    /// The options JavaScript passed, as JSON; null when it passed none.
    /// They come from the application: check them as any guest input.
    pub options: Value,
    /// The invocation's trusted [`Context`], if its caller attached one.
    pub context: Option<Context>,
    /// Rust's end of the channel. JavaScript's end belongs to the invocation
    /// that opened it and closes when that invocation ends.
    pub end: ChannelEnd,
}

/// Opens the channels of one `env` binding for JavaScript.
///
/// `open` returns a future that settles the open: Ok opens the channel for
/// JavaScript, an error refuses it. A service that accepts usually spawns a
/// task that drives `request.end`, then resolves. The future is polled in
/// the host pump of the invocation, within the host runtime when the App has
/// one; it must not call the same App again. Dropping it, as the end of the
/// invocation does, must cancel the open.
///
/// Services are trusted host code: they receive the invocation's
/// [`Context`], and nothing authorizes the options for them.
pub trait ChannelService: Send + Sync + 'static {
    fn open(&self, request: ChannelRequest) -> ChannelFuture;
}

/// Share one service between bindings or Apps.
impl<T: ChannelService + ?Sized> ChannelService for Arc<T> {
    fn open(&self, request: ChannelRequest) -> ChannelFuture {
        (**self).open(request)
    }
}

struct FunctionService<F>(F);

impl<F, Fut> ChannelService for FunctionService<F>
where
    F: Fn(ChannelRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<()>> + Send + 'static,
{
    fn open(&self, request: ChannelRequest) -> ChannelFuture {
        Box::pin((self.0)(request))
    }
}

/// Adapt an async Rust function to a channel service.
pub fn channel_fn<F, Fut>(function: F) -> impl ChannelService
where
    F: Fn(ChannelRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<()>> + Send + 'static,
{
    FunctionService(function)
}
