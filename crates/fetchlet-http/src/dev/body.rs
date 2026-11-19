use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};

/// The response body of a [`DevService`](super::DevService): the
/// generation's body, that body followed by the reload script, or the reload
/// poll's answer.
pub struct DevBody<B> {
    kind: Kind<B>,
}

enum Kind<B> {
    Plain(Pin<Box<B>>),
    Appended {
        body: Pin<Box<B>>,
        tail: Option<Bytes>,
        /// Trailers held back until the tail is sent.
        trailers: Option<Frame<Bytes>>,
        finished: bool,
    },
    Full(Option<Bytes>),
}

impl<B> DevBody<B> {
    pub(super) fn plain(body: B) -> Self {
        Self {
            kind: Kind::Plain(Box::pin(body)),
        }
    }

    pub(super) fn appended(body: B, tail: Bytes) -> Self {
        Self {
            kind: Kind::Appended {
                body: Box::pin(body),
                tail: Some(tail),
                trailers: None,
                finished: false,
            },
        }
    }

    pub(super) fn full(bytes: Bytes) -> Self {
        Self {
            kind: Kind::Full(Some(bytes)),
        }
    }
}

impl<B> Body for DevBody<B>
where
    B: Body<Data = Bytes>,
{
    type Data = Bytes;

    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, B::Error>>> {
        match &mut self.get_mut().kind {
            Kind::Plain(body) => body.as_mut().poll_frame(context),
            Kind::Full(bytes) => Poll::Ready(bytes.take().map(|bytes| Ok(Frame::data(bytes)))),
            Kind::Appended {
                body,
                tail,
                trailers,
                finished,
            } => {
                if !*finished {
                    match body.as_mut().poll_frame(context) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Some(Err(error))) => return Poll::Ready(Some(Err(error))),
                        Poll::Ready(Some(Ok(frame))) if frame.is_data() => {
                            return Poll::Ready(Some(Ok(frame)));
                        }
                        Poll::Ready(Some(Ok(frame))) => {
                            *trailers = Some(frame);
                            *finished = true;
                        }
                        Poll::Ready(None) => *finished = true,
                    }
                }
                if let Some(tail) = tail.take() {
                    return Poll::Ready(Some(Ok(Frame::data(tail))));
                }
                Poll::Ready(trailers.take().map(Ok))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        match &self.kind {
            Kind::Plain(body) => body.is_end_stream(),
            Kind::Full(bytes) => bytes.is_none(),
            Kind::Appended {
                tail,
                trailers,
                finished,
                ..
            } => *finished && tail.is_none() && trailers.is_none(),
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self.kind {
            Kind::Plain(body) => body.size_hint(),
            Kind::Full(bytes) => {
                SizeHint::with_exact(bytes.as_ref().map_or(0, |bytes| bytes.len() as u64))
            }
            Kind::Appended { .. } => SizeHint::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use http_body_util::{BodyExt, Full};

    use super::*;

    #[tokio::test]
    async fn the_tail_follows_the_body() {
        let body = DevBody::appended(
            Full::new(Bytes::from_static(b"<p>page</p>")),
            Bytes::from_static(b"<script></script>"),
        );
        let bytes = body.collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"<p>page</p><script></script>");
    }

    #[tokio::test]
    async fn the_tail_precedes_trailers() {
        let mut trailers = http::HeaderMap::new();
        trailers.insert("x-done", http::HeaderValue::from_static("1"));
        let body = DevBody::appended(
            Frames(
                vec![
                    Frame::data(Bytes::from_static(b"a")),
                    Frame::trailers(trailers),
                ]
                .into_iter(),
            ),
            Bytes::from_static(b"b"),
        );
        let collected = body.collect().await.unwrap();
        assert_eq!(collected.trailers().unwrap().get("x-done").unwrap(), "1");
        assert_eq!(&collected.to_bytes()[..], b"ab");
    }

    /// A body of ready frames.
    struct Frames(std::vec::IntoIter<Frame<Bytes>>);

    impl Body for Frames {
        type Data = Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
            Poll::Ready(self.0.next().map(Ok))
        }
    }
}
