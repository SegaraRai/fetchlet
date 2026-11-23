use std::sync::Arc;

use http::{HeaderMap, Method, header};
use url::Url;

use super::policy::parse_url;
use super::{Context, FetchPolicy, FetchTransport, RequireHttp2};
use crate::config::check_limit;
use crate::execution::with_timeout;
use crate::wire::{normalize_fetch_method, validate_headers};
use crate::{Body, Error, Limits, Request, Response, Result};

// Fetch HTTP-redirect algorithm: https://fetch.spec.whatwg.org/#http-redirect-fetch
const FETCH_REDIRECT_LIMIT: usize = 20;

type RequestRewrite = Arc<dyn Fn(&mut Request) -> Result<()> + Send + Sync>;

type CredentialProvider = Arc<dyn Fn(&Url, &mut HeaderMap) -> Result<()> + Send + Sync>;

/// A transport with an origin policy and optional trusted request callbacks.
#[derive(Clone)]
pub struct FetchService {
    transport: Arc<dyn FetchTransport>,
    policy: FetchPolicy,
    rewrite: Option<RequestRewrite>,
    credentials: Option<CredentialProvider>,
    forward_context: bool,
}

struct PreparedRequest {
    outgoing: Request,
    before_credentials: Request,
    url: Url,
}

impl FetchService {
    pub fn new(transport: impl FetchTransport, policy: FetchPolicy) -> Self {
        Self {
            transport: Arc::new(transport),
            policy,
            rewrite: None,
            credentials: None,
            forward_context: false,
        }
    }

    /// Pass the invocation's [`Context`] to the transport in request extensions.
    ///
    /// Use it for trusted in-process transports. Without it, the transport
    /// never receives a `Context`. [`OriginRouter`](crate::OriginRouter)
    /// enables it and decides per route.
    pub fn forward_context(mut self) -> Self {
        self.forward_context = true;
        self
    }

    /// Execute a Rust request through the same checks used by guest fetch calls.
    ///
    /// The response body is collected within `response_body_bytes` and the
    /// timeout, so the caller receives a complete, checked response.
    pub async fn fetch(&self, request: Request, limits: Limits) -> Result<Response> {
        limits.validate()?;

        let execution = async {
            let response = self
                .execute(request, Redirect::Follow, limits.clone())
                .await?;
            let (parts, body) = response.into_parts();
            let body = body
                .into_buffered(limits.response_body_bytes, "response body bytes")
                .await?;
            Ok(Response::from_parts(parts, body))
        };
        with_timeout(limits.timeout, execution).await?
    }

    /// Rewrite before permission checks. Inject secrets with `credentials` instead.
    pub fn rewrite(
        mut self,
        rewrite: impl Fn(&mut Request) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.rewrite = Some(Arc::new(rewrite));
        self
    }

    /// Provide credentials after checking the final destination.
    ///
    /// The provider must scope its credentials to the supplied URL. Headers it
    /// adds are discarded before constructing a redirected request.
    pub fn credentials(
        mut self,
        credentials: impl Fn(&Url, &mut HeaderMap) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.credentials = Some(Arc::new(credentials));
        self
    }

    /// Follow the request to its final response. A response body that the
    /// transport streams stays a stream: the caller reads it within its own
    /// `response_body_bytes` budget. Bodies of followed redirects are dropped.
    ///
    /// A request body that streams stays a stream too, read as the transport
    /// sends it within `request_body_bytes`. It cannot be sent twice, so as
    /// in browsers a redirect other than 303, which would resend it, fails
    /// the fetch with `Transport`; a 303 continues as a `GET` without it.
    pub(crate) async fn execute(
        &self,
        request: Request,
        redirect: Redirect,
        limits: Limits,
    ) -> Result<Response> {
        let mut request =
            request.map(|body| body.limited(limits.request_body_bytes, "request body bytes"));
        for redirects_followed in 0..=FETCH_REDIRECT_LIMIT {
            // Only the first hop streams: a redirect drops a streamed body.
            let streamed = !request.body().is_buffered();
            let prepared = self.prepare_request(request, &limits, streamed)?;
            let response = self.transport.send(prepared.outgoing).await?;
            validate_response(&response, &limits)?;

            if !is_redirect(&response) {
                return Ok(response);
            }

            match redirect {
                Redirect::Manual => return Ok(response),
                Redirect::Error => return Err(Error::PermissionDenied),
                Redirect::Follow => {}
            }

            if redirects_followed == FETCH_REDIRECT_LIMIT {
                return Err(Error::LimitExceeded("redirect hops"));
            }

            check_limit(limits.redirects, redirects_followed + 1, "redirect hops")?;
            request = request_for_redirect(
                prepared.before_credentials,
                &prepared.url,
                &response,
                streamed,
            )?;
        }

        Err(Error::LimitExceeded("redirect hops"))
    }

    /// Check a request and add its credentials. `streamed` is whether its
    /// body streams, which the transport then sends as it reads it and a
    /// redirect cannot resend.
    fn prepare_request(
        &self,
        mut request: Request,
        limits: &Limits,
        streamed: bool,
    ) -> Result<PreparedRequest> {
        if let Some(rewrite) = &self.rewrite {
            rewrite(&mut request)?;
        }

        let method = normalize_fetch_method(request.method())?;
        *request.method_mut() = method;

        check_limit(
            limits.url_bytes,
            request.uri().to_string().len(),
            "URL bytes",
        )?;
        self.policy.check(&request)?;
        validate_headers(request.headers(), limits.header_bytes)?;
        validate_request_body(&request, limits, streamed)?;

        let mut url = parse_url(&request.uri().to_string())?;
        url.set_fragment(None);
        *request.uri_mut() = url
            .as_str()
            .parse()
            .map_err(|_| Error::InvalidRequest("invalid rewritten URL".into()))?;

        let before_credentials = copy_request(&request, streamed)?;

        if let Some(credentials) = &self.credentials {
            credentials(&url, request.headers_mut())?;
        }

        if !self.forward_context {
            request.extensions_mut().remove::<Context>();
        }
        strip_transport_headers(request.headers_mut());
        validate_headers(request.headers(), limits.header_bytes)?;
        if streamed && !self.policy.allows_http1_streaming() {
            request.extensions_mut().insert(RequireHttp2);
        } else {
            request.extensions_mut().remove::<RequireHttp2>();
        }

        Ok(PreparedRequest {
            outgoing: request,
            before_credentials,
            url,
        })
    }
}

fn validate_request_body(request: &Request, limits: &Limits, streamed: bool) -> Result<()> {
    // A streamed body is counted as the transport reads it; the length it
    // declares is checked now.
    let (length, empty) = if streamed {
        (request.body().declared_len(), false)
    } else {
        let body = request.body().buffered()?;
        (body.len(), body.is_empty())
    };
    check_limit(limits.request_body_bytes, length, "request body bytes")?;

    let method_has_no_body = matches!(*request.method(), Method::GET | Method::HEAD);
    if method_has_no_body && !empty {
        return Err(Error::InvalidRequest("GET/HEAD request has a body".into()));
    }

    Ok(())
}

fn validate_response(response: &Response, limits: &Limits) -> Result<()> {
    validate_headers(response.headers(), limits.header_bytes)?;

    // A streamed body is counted as it is read; its declared length is
    // checked now.
    check_limit(
        limits.response_body_bytes,
        response.body().declared_len(),
        "response body bytes",
    )?;

    Ok(())
}

fn is_redirect(response: &Response) -> bool {
    matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308)
        && response.headers().contains_key(header::LOCATION)
}

/// The request a redirect leads to. `request` is the one before
/// credentials; with `streamed`, its body was sent as it streamed and only a
/// 303, which drops the body, can be followed.
fn request_for_redirect(
    mut request: Request,
    previous_url: &Url,
    response: &Response,
    streamed: bool,
) -> Result<Request> {
    let status = response.status().as_u16();
    // Fetch's HTTP-redirect fetch, step 11: a body without a source cannot
    // be sent again.
    if streamed && status != 303 {
        return Err(Error::Transport(
            "a redirect would resend a streamed request body".into(),
        ));
    }

    let mut locations = response.headers().get_all(header::LOCATION).iter();
    let location = locations
        .next()
        .ok_or_else(|| Error::InvalidRequest("missing redirect location".into()))?;

    if locations.next().is_some() {
        return Err(Error::InvalidRequest("multiple redirect locations".into()));
    }

    let location = location
        .to_str()
        .map_err(|_| Error::InvalidRequest("invalid redirect location".into()))?;
    let next_url = previous_url
        .join(location)
        .map_err(|_| Error::InvalidRequest("invalid redirect URL".into()))?;

    if previous_url.origin() != next_url.origin() {
        remove_credentials(request.headers_mut());
    }

    let post_becomes_get = matches!(status, 301 | 302) && request.method() == Method::POST;
    let see_other_becomes_get =
        status == 303 && !matches!(*request.method(), Method::GET | Method::HEAD);

    if post_becomes_get || see_other_becomes_get {
        *request.method_mut() = Method::GET;
        *request.body_mut() = Body::empty();
        remove_body_headers(request.headers_mut());
    }

    *request.uri_mut() = next_url
        .as_str()
        .parse()
        .map_err(|_| Error::InvalidRequest("invalid redirect URI".into()))?;

    Ok(request)
}

/// A copy of `request` for a redirect to start from. A streamed body is
/// not copied: only a redirect that drops it can be followed.
fn copy_request(request: &Request, streamed: bool) -> Result<Request> {
    let body = if streamed {
        Body::empty()
    } else {
        Body::from(request.body().buffered()?.to_vec())
    };
    let mut copied = Request::new(body);
    *copied.method_mut() = request.method().clone();
    *copied.uri_mut() = request.uri().clone();
    *copied.headers_mut() = request.headers().clone();
    // Trusted values such as the Context follow the request to each hop.
    *copied.extensions_mut() = request.extensions().clone();
    Ok(copied)
}

fn remove_credentials(headers: &mut HeaderMap) {
    for name in [
        header::AUTHORIZATION,
        header::COOKIE,
        header::PROXY_AUTHORIZATION,
    ] {
        headers.remove(name);
    }
}

fn remove_body_headers(headers: &mut HeaderMap) {
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_ENCODING,
        header::CONTENT_LANGUAGE,
        header::CONTENT_LOCATION,
    ] {
        headers.remove(name);
    }
}

fn strip_transport_headers(headers: &mut HeaderMap) {
    // Transports supply framing and Host using the checked URI.
    for name in [
        "host",
        "connection",
        "transfer-encoding",
        "content-length",
        "upgrade",
        "proxy-authorization",
        "proxy-connection",
        "keep-alive",
        "te",
        "trailer",
    ] {
        headers.remove(name);
    }
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Redirect {
    #[default]
    Follow,
    Manual,
    Error,
}
