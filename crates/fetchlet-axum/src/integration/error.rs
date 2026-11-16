use std::error::Error as StdError;

use axum::http::StatusCode;
use axum::http::uri::InvalidUriParts;
use axum::response::{IntoResponse, Response};
use http_body_util::LengthLimitError;

/// Conversion and execution failures available to the Rust error callback.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("public origin must be an HTTP(S) scheme and authority")]
    InvalidOrigin,
    #[error("invalid request URI: {0}")]
    InvalidRequestUri(InvalidUriParts),
    #[error("request body could not be collected: {0}")]
    Body(axum::Error),
    #[error("request context could not be serialized: {0}")]
    Context(serde_json::Error),
    #[error(transparent)]
    Execution(#[from] fetchlet::Error),
}

impl Error {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::InvalidOrigin | Self::Context(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::InvalidRequestUri(_) => StatusCode::BAD_REQUEST,
            Self::Body(error) => {
                let mut cause: Option<&(dyn StdError + 'static)> = Some(error);
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
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = self.status_code();
        (
            status,
            status.canonical_reason().unwrap_or("Request failed"),
        )
            .into_response()
    }
}
