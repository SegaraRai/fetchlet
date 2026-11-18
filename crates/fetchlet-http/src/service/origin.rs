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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_an_http_or_https_scheme_and_authority() {
        for value in [
            "https://app.test",
            "https://app.test/",
            "http://127.0.0.1:8080",
            "http://[::1]:3000/",
        ] {
            assert!(PublicOrigin::parse(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn refuses_anything_beyond_an_origin() {
        for value in [
            "app.test",
            "/path",
            "ftp://app.test",
            "https://user@app.test",
            "https://app.test/base",
            "https://app.test/?query",
            "https://app.test/#fragment",
            "https://",
            "",
        ] {
            assert!(
                matches!(PublicOrigin::parse(value), Err(Error::InvalidOrigin)),
                "{value}"
            );
        }
    }

    #[test]
    fn applies_the_origin_and_keeps_the_path_and_query() {
        let origin = PublicOrigin::parse("https://app.test:8443").unwrap();
        let uri: Uri = "http://client-chosen.example/a/b?c=d".parse().unwrap();
        assert_eq!(
            origin.apply(uri).unwrap().to_string(),
            "https://app.test:8443/a/b?c=d"
        );
        let authority_only: Uri = "client-chosen.example".parse().unwrap();
        assert_eq!(
            origin.apply(authority_only).unwrap().to_string(),
            "https://app.test:8443/"
        );
    }

    #[test]
    fn resolves_request_targets() {
        let origin = PublicOrigin::parse("http://localhost:3000/").unwrap();
        assert_eq!(
            origin.resolve("/search?q=1").unwrap().to_string(),
            "http://localhost:3000/search?q=1"
        );
        assert!(matches!(
            origin.resolve("/with space"),
            Err(Error::InvalidRequest(_))
        ));
    }
}
