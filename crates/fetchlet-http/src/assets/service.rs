use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::header::{
    ACCEPT_RANGES, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, ETAG, LOCATION,
};
use http::{HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::{Either, Full};
use tower_service::Service;

use super::archive::{Asset, AssetArchive};
use super::negotiate::{RangeRequest, accepts_brotli, decode_path, none_match, range};

/// The body of an [`AssetService`] response: an asset, or the fallback's body.
pub type AssetBody<B> = Either<Full<Bytes>, B>;

/// A Tower service that answers GET and HEAD from an [`AssetArchive`] and
/// passes every other request to `fallback`.
///
/// Paths missing from the archive and other methods reach the fallback, so
/// the application handles its own routes, actions and 404 pages.
#[derive(Clone, Debug)]
pub struct AssetService<S> {
    archive: Arc<AssetArchive>,
    fallback: S,
}

impl<S> AssetService<S> {
    pub fn new(archive: impl Into<Arc<AssetArchive>>, fallback: S) -> Self {
        Self {
            archive: archive.into(),
            fallback,
        }
    }
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for AssetService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
{
    type Response = Response<AssetBody<ResBody>>;
    type Error = S::Error;
    type Future = AssetFuture<S::Future, ResBody>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.fallback.poll_ready(cx)
    }

    fn call(&mut self, request: Request<ReqBody>) -> Self::Future {
        if request.method() == Method::GET || request.method() == Method::HEAD {
            let asset = decode_path(request.uri().path()).and_then(|path| {
                self.archive
                    .get(&path)
                    .map(|asset| respond(asset, &request))
            });
            if let Some(response) = asset {
                return AssetFuture::Ready(Some(response));
            }
        }
        AssetFuture::Fallback(Box::pin(self.fallback.call(request)))
    }
}

/// The future of an [`AssetService`] call.
pub enum AssetFuture<F, B> {
    Ready(Option<Response<Full<Bytes>>>),
    #[doc(hidden)]
    _Body(std::marker::PhantomData<fn() -> B>),
    Fallback(Pin<Box<F>>),
}

impl<F, B, E> Future for AssetFuture<F, B>
where
    F: Future<Output = Result<Response<B>, E>>,
{
    type Output = Result<Response<AssetBody<B>>, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match self.get_mut() {
            AssetFuture::Ready(response) => {
                let response = response.take().expect("polled after completion");
                Poll::Ready(Ok(response.map(Either::Left)))
            }
            AssetFuture::Fallback(future) => future
                .as_mut()
                .poll(cx)
                .map_ok(|response| response.map(Either::Right)),
            AssetFuture::_Body(_) => unreachable!(),
        }
    }
}

/// The response for an archived asset.
fn respond<B>(asset: Asset<'_>, request: &Request<B>) -> Response<Full<Bytes>> {
    let head = request.method() == Method::HEAD;
    let brotli = asset.is_brotli() && accepts_brotli(request.headers());
    let hash = hex(asset.hash());
    let etag = if brotli {
        format!("\"{hash}-br\"")
    } else {
        format!("\"{hash}\"")
    };

    let mut builder = Response::builder().status(asset.status());
    let query = request.uri().query().filter(|_| asset.keeps_query());
    for (name, value) in asset.headers() {
        match query {
            Some(query) if name == LOCATION => {
                let mut location = value.as_bytes().to_vec();
                location.push(b'?');
                location.extend_from_slice(query.as_bytes());
                match HeaderValue::from_bytes(&location) {
                    Ok(location) => builder = builder.header(name, location),
                    Err(_) => builder = builder.header(name, value),
                }
            }
            _ => builder = builder.header(name, value),
        }
    }
    let ok = asset.status() == StatusCode::OK;
    if ok {
        builder = builder.header(ETAG, &etag);
        if none_match(request.headers(), &etag) {
            return builder
                .status(StatusCode::NOT_MODIFIED)
                .body(Full::new(Bytes::new()))
                .unwrap_or_else(|_| internal_error());
        }
    }

    if brotli {
        let body = asset.stored();
        return finish(builder.header(CONTENT_ENCODING, "br"), body, head);
    }
    let body = match asset.decompressed() {
        Ok(body) => body,
        Err(_) => {
            return finish(
                Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR),
                Bytes::new(),
                head,
            );
        }
    };
    if !ok || asset.is_brotli() {
        return finish(builder, body, head);
    }
    // Identity entries answer one byte range.
    let size = body.len() as u64;
    builder = builder.header(ACCEPT_RANGES, "bytes");
    match range(request.headers(), size, &etag) {
        RangeRequest::Whole => finish(builder, body, head),
        RangeRequest::Satisfiable { start, end } => finish(
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{size}")),
            body.slice(start as usize..end as usize + 1),
            head,
        ),
        RangeRequest::Unsatisfiable => finish(
            builder
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{size}")),
            Bytes::new(),
            head,
        ),
    }
}

/// Set `Content-Length` and the body; HEAD keeps the length of the
/// representation it describes but sends no bytes.
fn finish(builder: http::response::Builder, body: Bytes, empty: bool) -> Response<Full<Bytes>> {
    let builder = builder.header(CONTENT_LENGTH, HeaderValue::from(body.len()));
    let body = if empty { Bytes::new() } else { body };
    builder
        .body(Full::new(body))
        .unwrap_or_else(|_| internal_error())
}

fn internal_error() -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    response
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
