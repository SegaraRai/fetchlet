//! The WHATWG URL parser and setters for the guest's `URL` class.
//!
//! The `url` crate implements the URL Standard, and its `quirks` module the
//! `URL` interface's getters and setters. The guest keeps the serialized
//! components; each parse or setter returns all of them at once.

use serde_json::{Value, json};
use url::{Url, quirks};

use crate::{Error, Result};

pub(crate) fn dispatch(operation: &str, input: &str) -> Result<Value> {
    match operation {
        "url.parse" => {
            let (input, base): (String, Option<String>) = serde_json::from_str(input)
                .map_err(|_| Error::InvalidRequest("invalid URL parse message".into()))?;
            Ok(parse(&input, base.as_deref()).map_or(Value::Null, |url| components(&url)))
        }
        "url.set" => {
            let (href, setter, value): (String, String, String) = serde_json::from_str(input)
                .map_err(|_| Error::InvalidRequest("invalid URL setter message".into()))?;
            let mut url = Url::parse(&href)
                .map_err(|_| Error::InvalidRequest("invalid URL record".into()))?;
            set(&mut url, &setter, &value)
        }
        _ => Err(Error::UnknownOperation),
    }
}

/// The basic URL parser with an optional base, as `new URL(url, base)` runs it.
fn parse(input: &str, base: Option<&str>) -> Option<Url> {
    match base {
        Some(base) => {
            let base = Url::parse(base).ok()?;
            Url::options().base_url(Some(&base)).parse(input).ok()
        }
        None => Url::parse(input).ok(),
    }
}

/// Apply one `URL` attribute setter. `href` reports a parse failure as null,
/// which the guest throws as a TypeError; the others ignore invalid values,
/// as the URL Standard specifies.
fn set(url: &mut Url, setter: &str, value: &str) -> Result<Value> {
    match setter {
        "href" => {
            if quirks::set_href(url, value).is_err() {
                return Ok(Value::Null);
            }
        }
        "protocol" => drop(quirks::set_protocol(url, value)),
        "username" => drop(quirks::set_username(url, value)),
        "password" => drop(quirks::set_password(url, value)),
        "host" => drop(quirks::set_host(url, value)),
        "hostname" => drop(quirks::set_hostname(url, value)),
        "port" => drop(quirks::set_port(url, value)),
        "pathname" => quirks::set_pathname(url, value),
        "search" => quirks::set_search(url, value),
        "hash" => quirks::set_hash(url, value),
        _ => return Err(Error::InvalidRequest("unknown URL setter".into())),
    }
    Ok(components(url))
}

/// The attribute values in the order the guest's `URL` class reads them.
fn components(url: &Url) -> Value {
    json!([
        quirks::href(url),
        quirks::protocol(url),
        quirks::username(url),
        quirks::password(url),
        quirks::host(url),
        quirks::hostname(url),
        quirks::port(url),
        quirks::pathname(url),
        quirks::search(url),
        quirks::hash(url),
        origin(url),
    ])
}

/// The URL Standard's origin. A blob: URL has its path URL's origin only
/// when that URL is http(s); the url crate's quirks::origin predates this.
fn origin(url: &Url) -> String {
    if url.scheme() == "blob" {
        return match Url::parse(url.path()) {
            Ok(inner) if matches!(inner.scheme(), "http" | "https") => quirks::origin(&inner),
            _ => "null".into(),
        };
    }
    quirks::origin(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_relative_to_a_base_and_reports_failure_as_null() {
        let value = dispatch("url.parse", r#"["../c?x#y", "https://a.test/b/d"]"#).unwrap();
        assert_eq!(value[0], "https://a.test/c?x#y");
        assert_eq!(value[10], "https://a.test");
        assert_eq!(
            dispatch("url.parse", r#"["/x", null]"#).unwrap(),
            Value::Null
        );
        assert_eq!(
            dispatch("url.parse", r#"["/x", "not a base"]"#).unwrap(),
            Value::Null
        );
    }

    #[test]
    fn blob_urls_have_an_origin_only_for_http_paths() {
        for (input, expected) in [
            ("blob:https://a.test:8443/id", "https://a.test:8443"),
            ("blob:ws://a.test/", "null"),
            ("blob:blob:https://a.test/", "null"),
            ("blob:file:///x", "null"),
        ] {
            let value =
                dispatch("url.parse", &serde_json::to_string(&(input, ())).unwrap()).unwrap();
            assert_eq!(value[10], expected, "{input}");
        }
    }

    #[test]
    fn setters_follow_the_url_standard() {
        let value = dispatch("url.set", r#"["https://a.test/p", "port", "8080"]"#).unwrap();
        assert_eq!(value[0], "https://a.test:8080/p");
        let ignored = dispatch("url.set", r#"["https://a.test/p", "port", "x"]"#).unwrap();
        assert_eq!(ignored[0], "https://a.test/p");
        let failed = dispatch("url.set", r#"["https://a.test/", "href", "::"]"#).unwrap();
        assert_eq!(failed, Value::Null);
    }

    #[test]
    fn rejects_malformed_messages_and_unknown_setters() {
        assert!(dispatch("url.parse", "{}").is_err());
        assert!(dispatch("url.set", r#"["https://a.test/", "origin", "x"]"#).is_err());
        assert!(dispatch("url.set", r#"["relative", "hash", "x"]"#).is_err());
        assert!(matches!(
            dispatch("url.other", "null"),
            Err(Error::UnknownOperation)
        ));
    }
}
