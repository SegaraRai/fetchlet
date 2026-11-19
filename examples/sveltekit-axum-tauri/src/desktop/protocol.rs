use std::sync::Arc;

use axum::body::Body;
use http_body_util::{BodyExt, Limited};
use tauri::http::header::{CONTENT_TYPE, HeaderValue};
use tauri::http::{Request, Response, StatusCode};
use tower::ServiceExt;

use crate::host::Host;

/// The URI scheme the window loads pages from.
pub(crate) const SCHEME: &str = "mdw";

/// The origin the application sees. WebView2 and Android serve custom schemes
/// as `http://<scheme>.localhost`; the other platforms use `<scheme>://localhost`.
/// Pages see this origin on every platform.
pub(crate) const PUBLIC_ORIGIN: &str = "http://mdw.localhost";

pub(crate) fn start_url() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://mdw.localhost/"
    } else {
        "mdw://localhost/"
    }
}

/// Answers webview requests with the same routes `mdw serve` puts behind
/// HTTP, in-process, from the build current when each request arrives.
/// Tauri takes complete bodies, so each response is collected within the
/// configured budget.
#[derive(Clone)]
pub(crate) struct Protocol {
    host: Arc<Host>,
    response_body_bytes: usize,
}

impl Protocol {
    pub fn new(host: Arc<Host>, response_body_bytes: usize) -> Self {
        Self {
            host,
            response_body_bytes,
        }
    }

    pub async fn respond(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let request = request.map(Body::from);
        let response = match self.host.current().oneshot(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        };
        let (parts, body) = response.into_parts();
        match Limited::new(body, self.response_body_bytes).collect().await {
            Ok(collected) => Response::from_parts(parts, collected.to_bytes().to_vec()),
            Err(error) => {
                eprintln!("response failed: {error}");
                let mut response = Response::new(b"Bad Gateway".to_vec());
                *response.status_mut() = StatusCode::BAD_GATEWAY;
                response.headers_mut().insert(
                    CONTENT_TYPE,
                    HeaderValue::from_static("text/plain; charset=utf-8"),
                );
                response
            }
        }
    }
}
