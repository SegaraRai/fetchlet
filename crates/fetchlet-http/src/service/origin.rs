use http::Uri;
use http::uri::{Authority, PathAndQuery, Scheme};

use super::Error;

/// The configured public scheme and authority of incoming requests.
///
/// Servers see a path and a Host header that clients choose; the application
/// sees this origin with the incoming path and query instead.
#[derive(Clone, Debug)]
pub struct PublicOrigin {
    scheme: Scheme,
    authority: Authority,
}

impl PublicOrigin {
    pub fn parse(value: &str) -> Result<Self, Error> {
        let uri: Uri = value.parse().map_err(|_| Error::InvalidOrigin)?;
        let (Some(scheme), Some(authority)) = (uri.scheme(), uri.authority()) else {
            return Err(Error::InvalidOrigin);
        };
        if !matches!(scheme.as_str(), "http" | "https")
            || authority.as_str().contains('@')
            || uri.path() != "/"
            || uri.query().is_some()
            || value.contains('#')
        {
            return Err(Error::InvalidOrigin);
        }
        Ok(Self {
            scheme: scheme.clone(),
            authority: authority.clone(),
        })
    }

    /// Replace the scheme and authority, keeping the path and query.
    pub fn apply(&self, uri: Uri) -> Result<Uri, Error> {
        let mut parts = uri.into_parts();
        parts.scheme = Some(self.scheme.clone());
        parts.authority = Some(self.authority.clone());
        if parts.path_and_query.is_none() {
            parts.path_and_query = Some(PathAndQuery::from_static("/"));
        }
        Uri::from_parts(parts).map_err(Error::InvalidRequestUri)
    }

    /// Apply the origin to a request target such as `/path?query`.
    pub fn resolve(&self, path_and_query: &str) -> Result<Uri, Error> {
        let path_and_query: PathAndQuery = path_and_query
            .parse()
            .map_err(|_| Error::InvalidRequest("invalid request target".into()))?;
        let mut parts = http::uri::Parts::default();
        parts.path_and_query = Some(path_and_query);
        self.apply(Uri::from_parts(parts).map_err(Error::InvalidRequestUri)?)
    }
}
