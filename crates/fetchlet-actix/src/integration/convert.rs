//! Conversions between actix-web's `http` 0.2 types and `http` 1 types.

use actix_web::body::SizedStream;
use actix_web::http::StatusCode;
use actix_web::http::header::{HeaderName, HeaderValue};
use actix_web::{HttpRequest, HttpResponse};

use fetchlet_tower::{Error, PublicOrigin};

use super::body::ResponseStream;

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
