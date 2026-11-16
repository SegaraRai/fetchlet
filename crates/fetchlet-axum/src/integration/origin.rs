use axum::http::Uri;
use axum::http::uri::{Authority, Scheme};

use super::Error;

#[derive(Clone)]
pub(super) struct Origin {
    scheme: Scheme,
    authority: Authority,
}

impl Origin {
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

    pub fn apply(&self, uri: Uri) -> Result<Uri, Error> {
        let mut parts = uri.into_parts();
        parts.scheme = Some(self.scheme.clone());
        parts.authority = Some(self.authority.clone());
        Uri::from_parts(parts).map_err(Error::InvalidRequestUri)
    }
}
