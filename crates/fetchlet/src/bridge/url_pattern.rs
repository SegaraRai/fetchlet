//! The URL Pattern Standard (https://urlpattern.spec.whatwg.org/) for the
//! guest's `URLPattern`.
//!
//! The `urlpattern` crate parses patterns and canonicalizes inputs, as it
//! does for Deno. Component regular expressions use ECMAScript syntax and
//! run in the guest's own RegExp engine, so a pattern means the same in
//! `URLPattern` as in a hand-written `RegExp`.

use serde_json::{Value, json};
use urlpattern::quirks::{self, EcmaRegexp, StringOrInit};
use urlpattern::{RegexSyntax, UrlPatternOptions};

use crate::{Error, Result};

pub(super) fn dispatch(operation: &str, input: &str) -> Result<Value> {
    match operation {
        "urlpattern.parse" => {
            let (input, base, ignore_case): (StringOrInit<'_>, Option<String>, bool) =
                serde_json::from_str(input)
                    .map_err(|_| Error::InvalidRequest("invalid URLPattern message".into()))?;
            Ok(parse(input, base.as_deref(), ignore_case))
        }
        "urlpattern.match" => {
            let (input, base): (StringOrInit<'_>, Option<String>) = serde_json::from_str(input)
                .map_err(|_| Error::InvalidRequest("invalid URLPattern message".into()))?;
            Ok(match_input(input, base.as_deref()))
        }
        _ => Err(Error::PermissionDenied),
    }
}

/// The pattern's components, or `{"error": message}` for an invalid pattern,
/// which the guest throws as a TypeError.
fn parse(input: StringOrInit<'_>, base: Option<&str>, ignore_case: bool) -> Value {
    let options = UrlPatternOptions {
        regex_syntax: RegexSyntax::EcmaScript,
        ignore_case,
    };
    let parsed = quirks::process_construct_pattern_input(input, base)
        .and_then(|init| quirks::parse_pattern::<EcmaRegexp>(init, options));
    match parsed {
        Ok(pattern) => serde_json::to_value(pattern).unwrap_or(Value::Null),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

/// The canonical components of a match input and the inputs as given, or
/// null when the input cannot match (an unparsable URL), or an error for an
/// init with a separate base URL.
fn match_input(input: StringOrInit<'_>, base: Option<&str>) -> Value {
    match quirks::process_match_input(input, base) {
        Ok(Some((input, inputs))) => match quirks::parse_match_input(input) {
            Some(components) => json!([components, inputs]),
            None => Value::Null,
        },
        Ok(None) => Value::Null,
        Err(error) => json!({ "error": error.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_patterns_and_reports_invalid_ones() {
        let value = dispatch(
            "urlpattern.parse",
            r#"["/books/:id", "https://a.test", false]"#,
        )
        .unwrap();
        assert_eq!(value["pathname"]["patternString"], "/books/:id");
        assert_eq!(value["pathname"]["groupNameList"], json!(["id"]));
        assert_eq!(value["hostname"]["patternString"], "a.test");
        let invalid = dispatch("urlpattern.parse", r#"["/books/(", null, false]"#).unwrap();
        assert!(invalid["error"].is_string());
    }

    #[test]
    fn canonicalizes_match_inputs() {
        let value = dispatch("urlpattern.match", r#"["/x?y#z", "https://A.test/base"]"#).unwrap();
        assert_eq!(value[0]["hostname"], "a.test");
        assert_eq!(value[0]["pathname"], "/x");
        assert_eq!(value[1], json!(["/x?y#z", "https://A.test/base"]));
        assert_eq!(
            dispatch("urlpattern.match", r#"["/relative", null]"#).unwrap(),
            Value::Null
        );
        assert!(dispatch("urlpattern.match", "{}").is_err());
    }
}
