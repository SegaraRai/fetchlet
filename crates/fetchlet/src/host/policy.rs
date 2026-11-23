use std::collections::BTreeSet;

use url::Url;

use crate::wire::normalize_fetch_method;
use crate::{Error, Request, Result};

/// Exact normalized origins; no wildcard or substring matching.
#[derive(Debug, Clone, Default)]
pub struct FetchPolicy {
    origins: BTreeSet<String>,
}

impl FetchPolicy {
    pub fn deny_all() -> Self {
        Self::default()
    }

    pub fn allow_origin(mut self, origin: &str) -> Result<Self> {
        self.origins.insert(normalize_origin(origin)?);
        Ok(self)
    }

    pub(super) fn from_origins(origins: impl IntoIterator<Item = String>) -> Self {
        Self {
            origins: origins.into_iter().collect(),
        }
    }

    /// Whether the policy allows the origin of a WebSocket URL, whose `ws:`
    /// and `wss:` count as `http:` and `https:`. This performs no DNS lookup.
    pub(crate) fn check_websocket(&self, url: &Url) -> Result<()> {
        let mut http = url.clone();
        let scheme = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        http.set_scheme(scheme)
            .map_err(|()| Error::InvalidRequest("invalid WebSocket URL".into()))?;
        if self.origins.contains(&http.origin().ascii_serialization()) {
            Ok(())
        } else {
            Err(Error::PermissionDenied)
        }
    }

    /// Validate the actual URI after any rewrite. This performs no DNS lookup.
    pub fn check(&self, request: &Request) -> Result<()> {
        let url = parse_url(&request.uri().to_string())?;
        if !self.origins.contains(&url.origin().ascii_serialization()) {
            return Err(Error::PermissionDenied);
        }
        normalize_fetch_method(request.method())?;
        Ok(())
    }
}

/// The ASCII serialization of a configured origin, which must be bare.
pub(super) fn normalize_origin(origin: &str) -> Result<String> {
    let url = parse_url(origin)?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(Error::Configuration(
            "an origin must not contain a path, query, or fragment".into(),
        ));
    }
    Ok(url.origin().ascii_serialization())
}

pub(crate) fn parse_url(input: &str) -> Result<Url> {
    let url =
        Url::parse(input).map_err(|_| Error::InvalidRequest("invalid absolute URL".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::InvalidRequest(
            "expected an HTTP(S) URL without credentials".into(),
        ));
    }
    Ok(url)
}
