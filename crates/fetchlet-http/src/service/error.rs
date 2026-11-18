use std::error::Error as StdError;

use bytes::Bytes;
use http::header::{CONTENT_TYPE, HeaderValue};
use http::uri::InvalidUriParts;
use http::{Response, StatusCode};
use http_body_util::LengthLimitError;

pub type BoxError = Box<dyn StdError + Send + Sync>;

/// Conversion and execution failures available to the Rust error callback.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("public origin must be an HTTP(S) scheme and authority")]
    InvalidOrigin,
    #[error("invalid request URI: {0}")]
    InvalidRequestUri(InvalidUriParts),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("request body could not be collected: {0}")]
    Body(BoxError),
    #[error("request context could not be serialized: {0}")]
    Context(serde_json::Error),
    #[error(transparent)]
    Execution(#[from] fetchlet::Error),
}

impl Error {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::InvalidOrigin | Self::Context(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::InvalidRequestUri(_) | Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Self::Body(error) => {
                let mut cause: Option<&(dyn StdError + 'static)> = Some(error.as_ref());
                while let Some(current) = cause {
                    if current.is::<LengthLimitError>() {
                        return StatusCode::PAYLOAD_TOO_LARGE;
                    }
                    cause = current.source();
                }
                StatusCode::BAD_REQUEST
            }
            Self::Execution(error) => match error {
                fetchlet::Error::DeadlineExceeded => StatusCode::GATEWAY_TIMEOUT,
                fetchlet::Error::WorkerClosed
                | fetchlet::Error::WorkerFailed(_)
                | fetchlet::Error::InstanceUnavailable => StatusCode::SERVICE_UNAVAILABLE,
                fetchlet::Error::InvalidRequest(_) => StatusCode::BAD_REQUEST,
                fetchlet::Error::PermissionDenied => StatusCode::FORBIDDEN,
                fetchlet::Error::LimitExceeded("request body bytes") => {
                    StatusCode::PAYLOAD_TOO_LARGE
                }
                fetchlet::Error::LimitExceeded("URL bytes") => StatusCode::URI_TOO_LONG,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
        }
    }

    /// A general HTTP response; details stay with the Rust error.
    pub fn response(&self) -> Response<fetchlet::Body> {
        let status = self.status_code();
        let reason = status.canonical_reason().unwrap_or("Request failed");
        let mut response =
            Response::new(fetchlet::Body::from(Bytes::from_static(reason.as_bytes())));
        *response.status_mut() = status;
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        response
    }
}

#[cfg(test)]
mod tests {
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use http::Uri;
    use http_body::Body as _;
    use http_body_util::{Full, Limited};

    use super::*;

    /// The error a body larger than its limit reports, as servers box it.
    fn length_limit_error() -> BoxError {
        let mut body = pin!(Limited::new(Full::new(Bytes::from_static(b"too long")), 1));
        let mut context = Context::from_waker(Waker::noop());
        match body.as_mut().poll_frame(&mut context) {
            Poll::Ready(Some(Err(error))) => error,
            _ => panic!("expected the length limit error"),
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("wrapped")]
    struct Wrapped(#[source] BoxError);

    #[test]
    fn configuration_and_request_errors_have_their_own_statuses() {
        assert_eq!(
            Error::InvalidOrigin.status_code(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        let context = serde_json::from_str::<u8>("x").unwrap_err();
        assert_eq!(
            Error::Context(context).status_code(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            Error::InvalidRequest("bad".into()).status_code(),
            StatusCode::BAD_REQUEST
        );
        // A scheme without an authority is not a valid URI.
        let mut parts = http::uri::Parts::default();
        parts.scheme = Some(http::uri::Scheme::HTTP);
        let uri_error = Uri::from_parts(parts).unwrap_err();
        assert_eq!(
            Error::InvalidRequestUri(uri_error).status_code(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn a_body_over_its_limit_is_payload_too_large_even_when_wrapped() {
        assert_eq!(
            Error::Body(length_limit_error()).status_code(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            Error::Body(Box::new(Wrapped(length_limit_error()))).status_code(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            Error::Body("connection reset".into()).status_code(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn execution_errors_map_onto_http_statuses() {
        use fetchlet::Error as Execution;
        for (error, status) in [
            (Execution::DeadlineExceeded, StatusCode::GATEWAY_TIMEOUT),
            (Execution::WorkerClosed, StatusCode::SERVICE_UNAVAILABLE),
            (
                Execution::WorkerFailed("panic".into()),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                Execution::InstanceUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                Execution::InvalidRequest("bad".into()),
                StatusCode::BAD_REQUEST,
            ),
            (Execution::PermissionDenied, StatusCode::FORBIDDEN),
            (
                Execution::LimitExceeded("request body bytes"),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            (
                Execution::LimitExceeded("URL bytes"),
                StatusCode::URI_TOO_LONG,
            ),
            (
                Execution::LimitExceeded("header bytes"),
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
            (
                Execution::JavaScript("TypeError".into()),
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
            (Execution::Reentrant, StatusCode::INTERNAL_SERVER_ERROR),
        ] {
            let message = error.to_string();
            assert_eq!(Error::from(error).status_code(), status, "{message}");
        }
    }

    #[test]
    fn responses_carry_only_the_status_reason() {
        let response =
            Error::Execution(fetchlet::Error::JavaScript("secret stack trace".into())).response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        let body = collect(response.into_body());
        assert_eq!(body, "Internal Server Error");
    }

    fn collect(body: fetchlet::Body) -> Bytes {
        let mut body = pin!(body);
        let mut context = Context::from_waker(Waker::noop());
        let mut bytes = Vec::new();
        loop {
            match body.as_mut().poll_frame(&mut context) {
                Poll::Ready(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        bytes.extend_from_slice(&data);
                    }
                }
                Poll::Ready(None) => return Bytes::from(bytes),
                _ => panic!("expected a ready body"),
            }
        }
    }
}
