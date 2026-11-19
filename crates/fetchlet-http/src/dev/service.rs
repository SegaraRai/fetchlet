use std::fmt;
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::header::{
    ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, HeaderValue,
};
use http::{Method, Request, Response, StatusCode};
use tower_service::Service;

use super::body::DevBody;
use super::reload::Shared;

/// The path the reload script polls for a new generation.
pub const RELOAD_POLL_PATH: &str = "/__fetchlet/reload";

/// The path of the reload script that HTML pages link to.
pub const RELOAD_SCRIPT_PATH: &str = "/__fetchlet/reload.js";

/// The reload script, which polls [`RELOAD_POLL_PATH`] with the token in its
/// own URL and reloads the page when the token changes.
const RELOAD_SCRIPT: &str = include_str!("../../js/dev-reload.js");

/// How long a poll waits for a new generation before answering with the
/// current one. Shorter than the idle timeouts of common proxies, so a poll
/// is not cut off in between.
const POLL_TIMEOUT: Duration = Duration::from_secs(25);

/// The Tower service of a [`DevReload`](super::DevReload).
///
/// Each request goes to the generation current when it arrives. HTML
/// responses get a `<script>` element appended that loads
/// [`RELOAD_SCRIPT_PATH`], which reloads the page when a new generation
/// starts. The service drops `Accept-Encoding` from requests to receive
/// bodies it can extend; responses that still carry a `Content-Encoding`
/// are left unchanged. `GET` [`RELOAD_SCRIPT_PATH`] and
/// [`RELOAD_POLL_PATH`] are answered by the service itself; every other
/// path reaches the generation.
pub struct DevService<S> {
    shared: Arc<Shared<S>>,
}

impl<S> Clone for DevService<S> {
    fn clone(&self) -> Self {
        Self {
            shared: self.shared.clone(),
        }
    }
}

impl<S> fmt::Debug for DevService<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("DevService").finish_non_exhaustive()
    }
}

impl<S> DevService<S> {
    pub(super) fn new(shared: Arc<Shared<S>>) -> Self {
        Self { shared }
    }
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for DevService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>> + Clone + Send + Sync + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: http_body::Body<Data = Bytes>,
{
    type Response = Response<DevBody<ResBody>>;

    type Error = S::Error;

    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, mut request: Request<ReqBody>) -> Self::Future {
        let get = request.method() == Method::GET;
        if get && request.uri().path() == RELOAD_SCRIPT_PATH {
            return Box::pin(async {
                Ok(fixed_response(
                    Bytes::from_static(RELOAD_SCRIPT.as_bytes()),
                    "text/javascript",
                ))
            });
        }
        if get && request.uri().path() == RELOAD_POLL_PATH {
            let seen = seen_token(request.uri().query());
            let mut tokens = self.shared.token.subscribe();
            return Box::pin(async move {
                let wait = tokens.wait_for(|token| Some(token.as_str()) != seen.as_deref());
                let _ = tokio::time::timeout(POLL_TIMEOUT, wait).await;
                let token = tokens.borrow().clone();
                Ok(fixed_response(Bytes::from(token), "text/plain"))
            });
        }
        let (mut service, token) = self.shared.current();
        request.headers_mut().remove(ACCEPT_ENCODING);
        let head = request.method() == Method::HEAD;
        Box::pin(async move {
            poll_fn(|context| service.poll_ready(context)).await?;
            let response = service.call(request).await?;
            Ok(inject(response, &token, head))
        })
    }
}

/// The token in `token=…`, percent-decoded as the script encodes it with
/// `encodeURIComponent`. `None` when it is absent or does not decode to
/// UTF-8, which the poll treats as an unknown token.
fn seen_token(query: Option<&str>) -> Option<String> {
    query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("token="))
        .and_then(percent_decode)
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// `value` as a URL query component: every byte other than an unreserved
/// character (RFC 3986) is percent-encoded, as `encodeURIComponent` does.
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// `value` as the text of a double-quoted HTML attribute.
fn escape_attribute(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '"' => escaped.push_str("&quot;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn fixed_response<B>(body: Bytes, content_type: &'static str) -> Response<DevBody<B>> {
    let mut response = Response::new(DevBody::full(body));
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Append the element that loads the reload script to an HTML response body.
fn inject<B>(response: Response<B>, token: &str, head: bool) -> Response<DevBody<B>> {
    let (mut parts, body) = response.into_parts();
    let html = parts
        .headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("text/html"))
        });
    let injectable = html
        && !head
        && parts.status != StatusCode::NOT_MODIFIED
        && !parts.headers.contains_key(CONTENT_ENCODING);
    if !injectable {
        return Response::from_parts(parts, DevBody::plain(body));
    }
    parts.headers.remove(CONTENT_LENGTH);
    Response::from_parts(
        parts,
        DevBody::appended(body, Bytes::from(script_element(token))),
    )
}

/// A module script element that loads [`RELOAD_SCRIPT_PATH`] with `token`.
/// The script is served from the page's own origin, so a Content Security
/// Policy that allows `'self'` scripts allows it. The token is encoded as a
/// query component and the URL escaped as an attribute value, so the element
/// stays one element whatever the token holds.
fn script_element(token: &str) -> String {
    let source = format!("{RELOAD_SCRIPT_PATH}?token={}", percent_encode(token));
    format!(
        "<script type=\"module\" src=\"{}\"></script>",
        escape_attribute(&source)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seen_token_comes_from_the_query() {
        assert_eq!(seen_token(Some("token=ab-1")).as_deref(), Some("ab-1"));
        assert_eq!(seen_token(Some("x=1&token=ab-2")).as_deref(), Some("ab-2"));
        assert_eq!(seen_token(Some("x=1")), None);
        assert_eq!(seen_token(None), None);
        assert_eq!(
            seen_token(Some("token=a%22%3C%20b")).as_deref(),
            Some("a\"< b")
        );
        assert_eq!(
            seen_token(Some("token=%E3%81%82")).as_deref(),
            Some("\u{3042}")
        );
        for broken in ["token=%", "token=%4", "token=%zz", "token=%FF"] {
            assert_eq!(seen_token(Some(broken)), None, "{broken}");
        }
    }

    #[test]
    fn tokens_round_trip_through_the_query() {
        for token in ["ab-1", "a\"<b>&c", "x y/z?#", "\u{3042}"] {
            assert_eq!(
                seen_token(Some(&format!("token={}", percent_encode(token)))).as_deref(),
                Some(token)
            );
        }
    }

    #[test]
    fn the_element_escapes_the_token() {
        let element = script_element("\"></script><script>alert(1)</script>&");
        assert_eq!(
            element,
            "<script type=\"module\" src=\"/__fetchlet/reload.js?token=\
             %22%3E%3C%2Fscript%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E%26\"></script>"
        );
        assert_eq!(escape_attribute("a&\"<>b"), "a&amp;&quot;&lt;&gt;b");
    }

    #[test]
    fn the_element_loads_the_script_with_the_token() {
        assert_eq!(
            script_element("ab-3"),
            "<script type=\"module\" src=\"/__fetchlet/reload.js?token=ab-3\"></script>"
        );
    }

    #[test]
    fn the_script_polls_the_poll_path() {
        assert!(RELOAD_SCRIPT.contains(&format!("`{RELOAD_POLL_PATH}?token=")));
    }
}
