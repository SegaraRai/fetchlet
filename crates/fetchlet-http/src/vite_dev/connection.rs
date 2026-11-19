use std::borrow::Cow;
use std::fmt;

use bytes::Bytes;
use fetchlet::{Body, FetchPolicy, FetchService, HostServices, transport_fn};
use http::uri::{Authority, PathAndQuery, Scheme};
use http::{HeaderValue, Method, Request, StatusCode, Uri};
use http_body_util::{BodyExt, Empty};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

use super::ViteProxy;
use crate::{Artifact, ArtifactError};

/// The binding name through which the development artifact reaches the Vite
/// dev server; `fetchlet/vite/dev-runner` reads the same name.
pub const VITE_BINDING: &str = "FETCHLET_VITE";

/// The origin the development artifact addresses the binding with. It never
/// resolves; the binding sends each request to the Vite dev server.
const BINDING_ORIGIN: &str = "http://vite.fetchlet.internal";

/// Where `fetchlet/vite` serves the development artifact.
const ARTIFACT_PATH: &str = "/@fetchlet/artifact/";

/// A failure to reach the Vite dev server or to read what it served.
#[derive(Debug, thiserror::Error)]
pub enum ViteDevError {
    /// The URL is not an `http` origin.
    #[error("the Vite dev server URL {0} is not an http origin")]
    Url(String),
    /// The request did not complete.
    #[error("the request to the Vite dev server for {path} failed: {message}")]
    Request { path: String, message: String },
    /// The server answered with an unexpected status.
    #[error(
        "the Vite dev server answered {path} with {status}; is fetchlet/vite one of its plugins?"
    )]
    Status { path: String, status: StatusCode },
    /// The development artifact is not valid.
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
}

/// A connection to a Vite dev server running `fetchlet/vite`, for
/// development without a build.
///
/// [`artifact`](Self::artifact) reads a development artifact whose server
/// module runs Vite's module runner in the engine and loads the app's server
/// module from Vite on each call, so a server edit takes effect on the next
/// request. [`host_services`](Self::host_services) adds the binding the runner
/// reaches Vite through, beside the application's own services and their
/// [`FetchPolicy`]s, and [`proxy`](Self::proxy) serves Vite's browser modules
/// in front of the app.
#[derive(Clone)]
pub struct ViteDev {
    scheme: Scheme,
    authority: Authority,
    client: Client<HttpConnector, Body>,
}

impl fmt::Debug for ViteDev {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ViteDev")
            .field(
                "origin",
                &format_args!("{}://{}", self.scheme, self.authority),
            )
            .finish_non_exhaustive()
    }
}

impl ViteDev {
    /// A connection to the Vite dev server at `url`, such as
    /// `http://localhost:5173`. Nothing is requested until it is used.
    pub fn new(url: &str) -> Result<Self, ViteDevError> {
        let invalid = || ViteDevError::Url(url.into());
        let uri: Uri = url.parse().map_err(|_| invalid())?;
        let (Some(scheme), Some(authority)) = (uri.scheme(), uri.authority()) else {
            return Err(invalid());
        };
        if *scheme != Scheme::HTTP {
            return Err(invalid());
        }
        Ok(Self {
            scheme: scheme.clone(),
            authority: authority.clone(),
            client: Client::builder(TokioExecutor::new()).build_http(),
        })
    }

    /// The development artifact, which the dev server builds for its
    /// configured backend when first requested. It has no client directory;
    /// browser modules come from Vite through [`proxy`](Self::proxy).
    pub async fn artifact(&self) -> Result<Artifact, ViteDevError> {
        let manifest = self.get(&format!("{ARTIFACT_PATH}fetchlet.json")).await?;
        let path = format!("{ARTIFACT_PATH}server.js");
        let server = String::from_utf8(self.get(&path).await?.to_vec()).map_err(|_| {
            ViteDevError::Request {
                path,
                message: "the server module is not UTF-8".into(),
            }
        })?;
        Ok(Artifact::embedded(&manifest, Cow::Owned(server), None)?)
    }

    /// `services` with the binding the development artifact loads modules
    /// through. The binding accepts only its own origin and forwards to the
    /// dev server; the application's services and policies are unchanged,
    /// and the binding is hidden from the server module's `env`.
    pub fn host_services(&self, services: HostServices) -> fetchlet::Result<HostServices> {
        let policy = FetchPolicy::deny_all().allow_origin(BINDING_ORIGIN)?;
        let connection = self.clone();
        services.service(
            VITE_BINDING,
            FetchService::new(
                transport_fn(move |request: fetchlet::Request| {
                    let connection = connection.clone();
                    async move { connection.forward(request).await }
                }),
                policy,
            ),
        )
    }

    /// A Tower service that answers the `GET` and `HEAD` requests Vite
    /// serves, such as browser modules and public files, and passes every
    /// other request, and whatever Vite answers with 404, to `app`.
    pub fn proxy<S>(&self, app: S) -> ViteProxy<S> {
        ViteProxy::new(self.clone(), app)
    }

    pub(super) fn uri(&self, path_and_query: Option<&PathAndQuery>) -> Uri {
        let mut parts = http::uri::Parts::default();
        parts.scheme = Some(self.scheme.clone());
        parts.authority = Some(self.authority.clone());
        parts.path_and_query = Some(
            path_and_query
                .cloned()
                .unwrap_or_else(|| PathAndQuery::from_static("/")),
        );
        Uri::from_parts(parts).expect("a scheme, an authority and a path form a URI")
    }

    pub(super) fn host(&self) -> HeaderValue {
        HeaderValue::from_str(self.authority.as_str()).expect("an authority is a header value")
    }

    pub(super) fn client(&self) -> &Client<HttpConnector, Body> {
        &self.client
    }

    async fn get(&self, path: &str) -> Result<Bytes, ViteDevError> {
        let failed = |message: String| ViteDevError::Request {
            path: path.into(),
            message,
        };
        let path_and_query = PathAndQuery::try_from(path).map_err(|e| failed(e.to_string()))?;
        let request = Request::builder()
            .method(Method::GET)
            .uri(self.uri(Some(&path_and_query)))
            .body(Body::from_http_body(Empty::<Bytes>::new()))
            .map_err(|e| failed(e.to_string()))?;
        let response = self
            .client
            .request(request)
            .await
            .map_err(|e| failed(e.to_string()))?;
        if response.status() != StatusCode::OK {
            return Err(ViteDevError::Status {
                path: path.into(),
                status: response.status(),
            });
        }
        let body = response
            .into_body()
            .collect()
            .await
            .map_err(|e| failed(e.to_string()))?;
        Ok(body.to_bytes())
    }

    /// Sends a request of the runner to the dev server, keeping its path.
    async fn forward(&self, request: fetchlet::Request) -> fetchlet::Result<fetchlet::Response> {
        let (mut parts, body) = request.into_parts();
        parts.uri = self.uri(parts.uri.path_and_query());
        parts.headers.insert(http::header::HOST, self.host());
        let response = self
            .client
            .request(Request::from_parts(parts, body))
            .await
            .map_err(|error| fetchlet::Error::Transport(format!("Vite dev server: {error}")))?;
        Ok(response.map(Body::from_http_body))
    }
}
