use http::Method;
use http::{HeaderName, HeaderValue, StatusCode};
use serde::{Deserialize, Serialize};

use crate::config::check_limit;
use crate::{Body, Error, Limits, Request, Response, Result};

/// Internal byte and header-pair representation for the JavaScript bridge.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WireRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct WireResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// The complete body, or the bytes already available when `stream` is set.
    pub body: Vec<u8>,
    /// A JavaScript response body that remains open in the current invocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<u64>,
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
    #[cfg(any(feature = "quickjs", feature = "boa", feature = "v8", test))]
    pub fn into_http(self, limits: &Limits) -> Result<Request> {
        check_limit(limits.url_bytes, self.url.len(), "URL bytes")?;
        let body = self.body.unwrap_or_default();
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

    pub async fn from_http(request: Request, limits: &Limits) -> Result<Self> {
        validate_headers(request.headers(), limits.header_bytes)?;
        let (parts, body) = request.into_parts();
        let url = parts.uri.to_string();
        check_limit(limits.url_bytes, url.len(), "URL bytes")?;
        let method = normalize_fetch_method(&parts.method)?;
        let data = body
            .collect_within(limits.request_body_bytes, "request body bytes")
            .await?;
        if matches!(method, Method::GET | Method::HEAD) && !data.is_empty() {
            return Err(Error::InvalidRequest("GET/HEAD request has a body".into()));
        }
        let headers = parts
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
        Ok(Self {
            url,
            method: method.to_string(),
            headers,
            body: (!data.is_empty()).then(|| data.to_vec()),
        })
    }
}

impl WireResponse {
    pub fn into_http(self, limits: &Limits) -> Result<Response> {
        check_limit(
            limits.response_body_bytes,
            self.body.len(),
            "response body bytes",
        )?;
        if !(200..=599).contains(&self.status) {
            return Err(Error::InvalidRequest("invalid response status".into()));
        }
        let has_body = !self.body.is_empty() || self.stream.is_some();
        if matches!(self.status, 204 | 205 | 304) && has_body {
            return Err(Error::InvalidRequest("body on a null-body response".into()));
        }
        let mut response = Response::new(Body::from(self.body));
        *response.status_mut() = StatusCode::from_u16(self.status)
            .map_err(|_| Error::InvalidRequest("invalid response status".into()))?;
        *response.headers_mut() = headers_from_wire(self.headers, limits.header_bytes)?;
        Ok(response)
    }

    #[cfg(any(feature = "quickjs", feature = "boa", feature = "v8", test))]
    pub fn from_http(response: Response, limits: &Limits) -> Result<Self> {
        validate_headers(response.headers(), limits.header_bytes)?;
        let (parts, body) = response.into_parts();
        let data = body.buffered()?;
        check_limit(
            limits.response_body_bytes,
            data.len(),
            "response body bytes",
        )?;
        let wire = Self {
            status: parts.status.as_u16(),
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
            body: data.to_vec(),
            stream: None,
        };
        if !(200..=599).contains(&wire.status)
            || matches!(wire.status, 204 | 205 | 304) && !wire.body.is_empty()
        {
            return Err(Error::InvalidRequest("invalid response status/body".into()));
        }
        Ok(wire)
    }
}
