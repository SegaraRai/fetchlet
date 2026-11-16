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
        let url = parse_url(origin)?;
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return Err(Error::Configuration(
                "an allowed origin must not contain a path, query, or fragment".into(),
            ));
        }
        self.origins.insert(url.origin().ascii_serialization());
        Ok(self)
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
