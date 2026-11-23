use http::Method;
use http::{HeaderName, HeaderValue, StatusCode};
use serde::{Deserialize, Serialize};

use super::byte_store::{BodyTransfer, BridgeBytes, WireBytes};
use crate::config::check_limit;
use crate::{Body, Error, Limits, Request, Response, Result};

/// Internal byte and header-pair representation for the JavaScript bridge.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WireRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<WireBytes>,
    /// A body source that JavaScript reads on demand, in place of `body`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct WireResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// The complete body, or the bytes already available when `stream` is set.
    pub body: WireBytes,
    /// A JavaScript response body that remains open in the current invocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<u64>,
    /// The channel of the WebSocket upgrade a Fetch handler accepted; the
    /// response is then a 101 without a body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upgrade: Option<u64>,
}

/// Apply Fetch's method rules: https://fetch.spec.whatwg.org/#concept-method-normalize
pub(crate) fn normalize_fetch_method(method: &Method) -> Result<Method> {
    const FORBIDDEN: [&str; 3] = ["CONNECT", "TRACE", "TRACK"];
    const NORMALIZED: [&str; 6] = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"];

    let spelling = method.as_str();
    if FORBIDDEN
        .iter()
        .any(|name| spelling.eq_ignore_ascii_case(name))
    {
        return Err(Error::PermissionDenied);
    }

    for name in NORMALIZED {
        if spelling.eq_ignore_ascii_case(name) {
            return Method::from_bytes(name.as_bytes())
                .map_err(|_| Error::InvalidRequest("invalid method".into()));
        }
    }

    // Fetch preserves the spelling of extension methods.
    Ok(method.clone())
}

pub(crate) fn validate_headers(headers: &http::HeaderMap, limit: Option<usize>) -> Result<()> {
    let mut size = 0usize;
    for (name, value) in headers {
        size = size
            .checked_add(name.as_str().len())
            .and_then(|n| n.checked_add(value.as_bytes().len()))
            .ok_or(Error::LimitExceeded("header bytes"))?;
        check_limit(limit, size, "header bytes")?;
    }
    Ok(())
}

pub(super) fn headers_from_wire(
    pairs: Vec<(String, String)>,
    limit: Option<usize>,
) -> Result<http::HeaderMap> {
    let mut headers = http::HeaderMap::new();
    let mut size = 0usize;
    for (name, value) in pairs {
        size = size
            .checked_add(name.len())
            .and_then(|n| n.checked_add(value.len()))
            .ok_or(Error::LimitExceeded("header bytes"))?;
        check_limit(limit, size, "header bytes")?;
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| Error::InvalidRequest("invalid header name".into()))?;
        let value = HeaderValue::from_bytes(value.as_bytes())
            .map_err(|_| Error::InvalidRequest("invalid header value".into()))?;
        headers
            .try_append(name, value)
            .map_err(|_| Error::LimitExceeded("header count"))?;
    }
    Ok(headers)
}

impl WireRequest {
    #[cfg(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing",
        test
    ))]
    pub fn into_http(self, limits: &Limits, bytes: &mut impl BridgeBytes) -> Result<Request> {
        check_limit(limits.url_bytes, self.url.len(), "URL bytes")?;
        if self.stream.is_some() {
            // Guest outbound bodies are read to the end in JavaScript first.
            return Err(Error::InvalidRequest(
                "outbound request bodies are buffered".into(),
            ));
        }
        let body = match self.body {
            Some(body) => bytes.receive(body)?,
            None => bytes::Bytes::new(),
        };
        check_limit(limits.request_body_bytes, body.len(), "request body bytes")?;
        let method = Method::from_bytes(self.method.as_bytes())
            .map_err(|_| Error::InvalidRequest("invalid method".into()))?;
        let method = normalize_fetch_method(&method)?;
        if matches!(method, Method::GET | Method::HEAD) && !body.is_empty() {
            return Err(Error::InvalidRequest("GET/HEAD request has a body".into()));
        }
        let mut request = http::Request::builder()
            .method(method)
            .uri(self.url)
            .body(Body::from(body))
            .map_err(|_| Error::InvalidRequest("invalid request URI".into()))?;
        *request.headers_mut() = headers_from_wire(self.headers, limits.header_bytes)?;
        Ok(request)
    }

    pub async fn from_http(
        request: Request,
        limits: &Limits,
        bytes: &mut impl BridgeBytes,
    ) -> Result<Self> {
        validate_headers(request.headers(), limits.header_bytes)?;
        let (parts, body) = request.into_parts();
        let url = parts.uri.to_string();
        check_limit(limits.url_bytes, url.len(), "URL bytes")?;
        let method = normalize_fetch_method(&parts.method)?;
        let headers: Vec<(String, String)> = parts
            .headers
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|v| (name.to_string(), v.to_owned()))
                    .map_err(|_| {
                        Error::InvalidRequest("header is not representable in the JS bridge".into())
                    })
            })
            .collect::<Result<_>>()?;
        let resource = "request body bytes";
        // GET and HEAD bodies are collected so that a non-empty one is rejected.
        let transfer = if matches!(method, Method::GET | Method::HEAD) {
            BodyTransfer::Collect(body)
        } else {
            bytes.stream(body, limits.request_body_bytes, resource)?
        };
        let (body, stream) = match transfer {
            BodyTransfer::Stream(id) => (None, Some(id)),
            BodyTransfer::Collect(body) => {
                let data = body
                    .collect_within(limits.request_body_bytes, resource)
                    .await?;
                if matches!(method, Method::GET | Method::HEAD) && !data.is_empty() {
                    return Err(Error::InvalidRequest("GET/HEAD request has a body".into()));
                }
                let body = if data.is_empty() {
                    None
                } else {
                    Some(bytes.send(data)?)
                };
                (body, None)
            }
        };
        Ok(Self {
            url,
            method: method.to_string(),
            headers,
            body,
            stream,
        })
    }
}

impl WireResponse {
    pub fn into_http(self, limits: &Limits, bytes: &mut impl BridgeBytes) -> Result<Response> {
        let body = bytes.receive(self.body)?;
        check_limit(
            limits.response_body_bytes,
            body.len(),
            "response body bytes",
        )?;
        let has_body = !body.is_empty() || self.stream.is_some();
        if self.upgrade.is_some() {
            if self.status != 101 || has_body {
                return Err(Error::InvalidRequest("invalid upgrade response".into()));
            }
        } else if !(200..=599).contains(&self.status) {
            return Err(Error::InvalidRequest("invalid response status".into()));
        }
        if matches!(self.status, 204 | 205 | 304) && has_body {
            return Err(Error::InvalidRequest("body on a null-body response".into()));
        }
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = StatusCode::from_u16(self.status)
            .map_err(|_| Error::InvalidRequest("invalid response status".into()))?;
        *response.headers_mut() = headers_from_wire(self.headers, limits.header_bytes)?;
        Ok(response)
    }

    #[cfg(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing",
        test
    ))]
    pub fn from_http(
        response: Response,
        limits: &Limits,
        bytes: &mut impl BridgeBytes,
    ) -> Result<Self> {
        validate_headers(response.headers(), limits.header_bytes)?;
        let (parts, body) = response.into_parts();
        let status = parts.status.as_u16();
        if !(200..=599).contains(&status) {
            return Err(Error::InvalidRequest("invalid response status/body".into()));
        }
        let resource = "response body bytes";
        let (body, stream) = if matches!(status, 204 | 205 | 304) {
            // A null-body status has no body; a streamed one is dropped unread.
            if !body.buffered().unwrap_or_default().is_empty() {
                return Err(Error::InvalidRequest("invalid response status/body".into()));
            }
            (WireBytes::default(), None)
        } else {
            match bytes.stream(body, limits.response_body_bytes, resource)? {
                BodyTransfer::Stream(id) => (WireBytes::default(), Some(id)),
                BodyTransfer::Collect(body) => {
                    let data = body.into_bytes()?;
                    check_limit(limits.response_body_bytes, data.len(), resource)?;
                    (bytes.send(data)?, None)
                }
            }
        };
        Ok(Self {
            status,
            headers: parts
                .headers
                .iter()
                .map(|(name, value)| {
                    value
                        .to_str()
                        .map(|v| (name.to_string(), v.to_owned()))
                        .map_err(|_| {
                            Error::InvalidRequest(
                                "header is not representable in the JS bridge".into(),
                            )
                        })
                })
                .collect::<Result<_>>()?,
            body,
            stream,
            upgrade: None,
        })
    }
}
