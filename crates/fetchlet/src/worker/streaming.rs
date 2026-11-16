use std::time::Instant;

use crate::App;
use crate::app::OpenResponseBody;
use crate::fetch::BodySender;

/// Pump a JavaScript response body into a Rust body channel.
///
/// Production follows demand: the next chunk is pulled only after the channel
/// has room. Dropping the Rust body between pulls cancels the JavaScript
/// stream and keeps the instance; dropping it during a pull abandons that
/// evaluation and retires the instance. The invocation deadline covers the
/// whole body, including time spent waiting for the consumer.
pub(super) async fn stream_response_body(
    app: &mut App,
    mut open: OpenResponseBody,
    sender: BodySender,
) {
    loop {
        let permit = tokio::select! {
            permit = sender.reserve() => permit,
            () = sleep_until(open.deadline()) => {
                // The consumer stalled past the deadline. Ending without a last
                // chunk reports the body as aborted (Error::InvocationClosed).
                app.cancel_response_body(open).await;
                return;
            }
        };
        let Ok(permit) = permit else {
            app.cancel_response_body(open).await;
            return;
        };
        let pulled = tokio::select! {
            pulled = app.pull_response_body(open) => pulled,
            () = sender.closed() => return,
        };
        match pulled {
            Err(error) => {
                permit.send(Err(error));
                return;
            }
            Ok(pulled) => {
                let last = pulled.next.is_none();
                permit.send(Ok((pulled.chunk, last)));
                match pulled.next {
                    Some(next) => open = next,
                    None => return,
                }
            }
        }
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}
