//! Conversions between actix-web's `http` 0.2 types and `http` 1 types.

use actix_web::body::SizedStream;
use actix_web::http::StatusCode;
use actix_web::http::header::{HeaderName, HeaderValue};
use actix_web::{HttpRequest, HttpResponse};

use super::body::ResponseStream;
use crate::{Error, PublicOrigin};

/// Response headers that actix derives from the body it sends.
const FRAMING_HEADERS: [&str; 3] = ["content-length", "transfer-encoding", "connection"];

/// The request head with the public origin applied.
pub(super) fn request_head(
    request: &HttpRequest,
    origin: &PublicOrigin,
) -> Result<http::request::Parts, Error> {
    let method = http::Method::from_bytes(request.method().as_str().as_bytes())
        .map_err(|_| Error::InvalidRequest("invalid method".into()))?;
    let target = request
        .uri()
        .path_and_query()
        .map_or("/", |target| target.as_str());
    let mut head = http::Request::builder()
        .method(method)
        .uri(origin.resolve(target)?)
        .body(())
        .map_err(|error| Error::InvalidRequest(error.to_string()))?
        .into_parts()
        .0;
    for (name, value) in request.headers() {
        let name = http::HeaderName::from_bytes(name.as_str().as_bytes())
            .map_err(|_| Error::InvalidRequest("invalid header name".into()))?;
        let value = http::HeaderValue::from_bytes(value.as_bytes())
            .map_err(|_| Error::InvalidRequest("invalid header value".into()))?;
        head.headers.append(name, value);
    }
    Ok(head)
}

/// The declared request body length, and whether a body follows at all.
pub(super) fn declared_body(head: &http::request::Parts) -> (Option<u64>, bool) {
    let declared = head
        .headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let chunked = head.headers.contains_key(http::header::TRANSFER_ENCODING);
    (declared, declared.map_or(chunked, |length| length > 0))
}

pub(super) fn response(response: http::Response<fetchlet::Body>) -> HttpResponse {
    let (parts, body) = response.into_parts();
    let status =
        StatusCode::from_u16(parts.status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = HttpResponse::build(status);
    for (name, value) in &parts.headers {
        if FRAMING_HEADERS.contains(&name.as_str()) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            builder.append_header((name, value));
        }
    }
    let length = http_body::Body::size_hint(&body).exact();
    let stream = ResponseStream(body);
    match length {
        Some(length) => builder.body(SizedStream::new(length, stream)),
        None => builder.streaming(stream),
    }
}

#[cfg(test)]
mod tests {
    use actix_web::body::{BodySize, MessageBody};
    use actix_web::test::TestRequest;

    use super::*;

    fn origin() -> PublicOrigin {
        PublicOrigin::parse("https://public.test").unwrap()
    }

    #[test]
    fn the_request_head_uses_the_public_origin_and_keeps_every_header() {
        let request = TestRequest::post()
            .uri("http://internal:8080/path?q=1")
            .insert_header(("host", "internal:8080"))
            .append_header(("accept", "text/html"))
            .append_header(("accept", "application/json"))
            .to_http_request();
        let head = request_head(&request, &origin()).unwrap();
        assert_eq!(head.method, http::Method::POST);
        assert_eq!(head.uri, "https://public.test/path?q=1");
        let accept: Vec<_> = head.headers.get_all("accept").iter().collect();
        assert_eq!(accept, ["text/html", "application/json"]);
        assert_eq!(head.headers["host"], "internal:8080");
    }

    #[test]
    fn extension_methods_and_bare_paths_convert() {
        let request = TestRequest::default()
            .method(actix_web::http::Method::from_bytes(b"PURGE").unwrap())
            .uri("/")
            .to_http_request();
        let head = request_head(&request, &origin()).unwrap();
        assert_eq!(head.method.as_str(), "PURGE");
        assert_eq!(head.uri, "https://public.test/");
    }

    fn head_with(headers: &[(&'static str, &'static str)]) -> http::request::Parts {
        let mut builder = http::Request::builder();
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(()).unwrap().into_parts().0
    }

    #[test]
    fn a_body_follows_a_positive_length_or_chunked_framing() {
        assert_eq!(declared_body(&head_with(&[])), (None, false));
        assert_eq!(
            declared_body(&head_with(&[("content-length", "0")])),
            (Some(0), false)
        );
        assert_eq!(
            declared_body(&head_with(&[("content-length", "12")])),
            (Some(12), true)
        );
        assert_eq!(
            declared_body(&head_with(&[("transfer-encoding", "chunked")])),
            (None, true)
        );
        assert_eq!(
            declared_body(&head_with(&[("content-length", "nope")])),
            (None, false)
        );
    }

    #[test]
    fn the_response_drops_framing_headers_and_keeps_the_rest() {
        let response = http::Response::builder()
            .status(201)
            .header("content-length", "999")
            .header("transfer-encoding", "chunked")
            .header("connection", "close")
            .header("set-cookie", "a=1")
            .header("set-cookie", "b=2")
            .body(fetchlet::Body::from("hello"))
            .unwrap();
        let response = super::response(response);
        assert_eq!(response.status(), StatusCode::CREATED);
        let headers = response.headers();
        assert!(!headers.contains_key("content-length"));
        assert!(!headers.contains_key("transfer-encoding"));
        assert!(!headers.contains_key("connection"));
        assert_eq!(headers.get_all("set-cookie").count(), 2);
        assert_eq!(response.into_body().size(), BodySize::Sized(5));
    }

    #[test]
    fn a_body_without_a_known_length_streams() {
        let body = fetchlet::Body::from_http_body(http_body_util::StreamBody::new(one_chunk()));
        let response = super::response(http::Response::new(body));
        assert_eq!(response.into_body().size(), BodySize::Stream);
    }

    fn one_chunk()
    -> impl futures_core::Stream<Item = Result<http_body::Frame<bytes::Bytes>, std::io::Error>>
    + Send
    + Sync
    + 'static {
        struct Once(Option<bytes::Bytes>);
        impl futures_core::Stream for Once {
            type Item = Result<http_body::Frame<bytes::Bytes>, std::io::Error>;
            fn poll_next(
                mut self: std::pin::Pin<&mut Self>,
                _context: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Self::Item>> {
                std::task::Poll::Ready(self.0.take().map(|data| Ok(http_body::Frame::data(data))))
            }
        }
        Once(Some(bytes::Bytes::from_static(b"chunk")))
    }
}
