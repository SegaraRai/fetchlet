use std::future::Future;

use super::App;
use crate::bridge::InvocationScope;
use crate::execution::{connection_invocation, deadline_after};
use crate::{CloseFrame, HeldConnection};

/// A connection a Fetch invocation accepted, such as a server WebSocket. It
/// owns the invocation's host scope and its place among the pool's held
/// connections until [`App::hold_connection`] ends it.
pub(crate) struct OpenConnection {
    channel: u64,
    scope: InvocationScope,
    _held: HeldConnection,
}

impl OpenConnection {
    pub(super) fn new(channel: u64, scope: InvocationScope, held: HeldConnection) -> Self {
        Self {
            channel,
            scope,
            _held: held,
        }
    }

    /// End the connection without holding it.
    pub(super) fn into_scope(self) -> InvocationScope {
        self.scope
    }
}

impl App {
    /// Run the invocation of an accepted connection until its channel
    /// closes: messages, timers and host operations reach JavaScript as in
    /// any invocation.
    ///
    /// `Limits::connection_idle_timeout` and `Limits::connection_lifetime`
    /// close the channel with code 1001, as does `stopping` when it
    /// completes. After the lifetime, JavaScript has `Limits::timeout` to
    /// handle the close; an invocation still running then retires the
    /// instance.
    pub(crate) async fn hold_connection(
        &mut self,
        open: OpenConnection,
        stopping: impl Future<Output = ()>,
    ) {
        let host = self.host.clone();
        // The close at the end of the lifetime, then `timeout` to handle it.
        // Without both, the connection has no deadline, as a call has none
        // without `timeout`.
        let deadline = deadline_after(
            self.limits
                .connection_lifetime
                .zip(self.limits.timeout)
                .and_then(|(lifetime, timeout)| lifetime.checked_add(timeout)),
        );
        let expression = connection_invocation(open.channel);
        {
            let evaluation = self.evaluate(expression, deadline);
            tokio::pin!(evaluation, stopping);
            let mut stopped = false;
            loop {
                tokio::select! {
                    // The evaluation records whether the instance stays reusable.
                    _ = &mut evaluation => break,
                    () = &mut stopping, if !stopped => {
                        stopped = true;
                        host.close_channels(&CloseFrame::new(
                            CloseFrame::GOING_AWAY,
                            "the server is shutting down",
                        ));
                    }
                }
            }
        }
        self.close(open.scope);
    }
}
