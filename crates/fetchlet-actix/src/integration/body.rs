use std::future::poll_fn;
use std::pin::Pin;
use std::task::{Context, Poll};

use actix_web::web::Payload;
use bytes::{Bytes, BytesMut};
use futures_core::Stream;
use http_body::{Frame, SizeHint};
use tokio::sync::mpsc;

use fetchlet_tower::Error;

/// Chunks forwarded from an actix payload, which stays on its own thread.
const FORWARDED_CHUNKS: usize = 1;

async fn next_chunk(payload: &mut Payload) -> Option<Result<Bytes, String>> {
    poll_fn(|context| Pin::new(&mut *payload).poll_next(context))
        .await
        .map(|chunk| chunk.map_err(|error| error.to_string()))
}

/// Collect a payload within the request body budget.
pub(super) async fn collect(mut payload: Payload, limit: Option<usize>) -> Result<Bytes, Error> {
    let mut data = BytesMut::new();
    while let Some(chunk) = next_chunk(&mut payload).await {
        let chunk = chunk.map_err(|error| Error::Body(error.into()))?;
        if limit.is_some_and(|limit| data.len() + chunk.len() > limit) {
            return Err(fetchlet::Error::LimitExceeded("request body bytes").into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data.freeze())
}

/// A request body that a local task feeds from the actix payload.
///
/// actix payloads are not `Send`, while application bodies cross to the
/// worker thread. The task stops when the body is dropped or the payload ends.
pub(super) struct ForwardedBody {
    receiver: mpsc::Receiver<Result<Bytes, String>>,
    declared: Option<u64>,
}

impl ForwardedBody {
    pub fn spawn(mut payload: Payload, declared: Option<u64>) -> Self {
        let (sender, receiver) = mpsc::channel(FORWARDED_CHUNKS);
        actix_web::rt::spawn(async move {
            loop {
                let chunk = tokio::select! {
                    () = sender.closed() => return,
                    chunk = next_chunk(&mut payload) => chunk,
                };
                let Some(chunk) = chunk else {
                    return;
                };
                let failed = chunk.is_err();
                if sender.send(chunk).await.is_err() || failed {
                    return;
                }
            }
        });
        Self { receiver, declared }
    }
}

impl http_body::Body for ForwardedBody {
    type Data = Bytes;
    type Error = String;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, String>>> {
        self.receiver
            .poll_recv(context)
            .map(|chunk| chunk.map(|chunk| chunk.map(Frame::data)))
    }

    fn size_hint(&self) -> SizeHint {
        self.declared
            .map_or_else(SizeHint::default, SizeHint::with_exact)
    }
}

/// The data of an application response body, for actix's body types.
pub(super) struct ResponseStream(pub fetchlet::Body);

impl Stream for ResponseStream {
    type Item = Result<Bytes, fetchlet::Error>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            let frame = match http_body::Body::poll_frame(Pin::new(&mut self.0), context) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Some(Err(error))),
                Poll::Ready(Some(Ok(frame))) => frame,
            };
            // Trailers are not forwarded.
            if let Ok(data) = frame.into_data() {
                return Poll::Ready(Some(Ok(data)));
            }
        }
    }
}
