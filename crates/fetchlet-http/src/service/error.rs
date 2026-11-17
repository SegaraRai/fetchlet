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
