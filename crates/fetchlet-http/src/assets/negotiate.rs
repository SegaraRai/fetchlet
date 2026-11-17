//! Request header parsing for asset responses.

use http::HeaderMap;
use http::header::{ACCEPT_ENCODING, IF_NONE_MATCH, IF_RANGE, RANGE};

/// Whether the client accepts `br`, by RFC 9110 section 12.5.3: an explicit
/// `br` with a nonzero weight, or `*` with a nonzero weight when `br` is not
/// listed.
pub(super) fn accepts_brotli(headers: &HeaderMap) -> bool {
    let mut brotli = None;
    let mut any = None;
    for value in headers.get_all(ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else { continue };
        for item in value.split(',') {
            let mut parts = item.split(';');
            let coding = parts.next().unwrap_or("").trim();
            let weight = parts
                .find_map(|parameter| {
                    let (name, value) = parameter.split_once('=')?;
                    name.trim()
                        .eq_ignore_ascii_case("q")
                        .then(|| value.trim().parse::<f32>().ok())
                        .flatten()
                })
                .unwrap_or(1.0);
            if coding.eq_ignore_ascii_case("br") {
                brotli = Some(weight > 0.0);
            } else if coding == "*" {
                any = Some(weight > 0.0);
            }
        }
    }
    brotli.or(any).unwrap_or(false)
}

/// Whether `If-None-Match` matches `etag`, by weak comparison.
pub(super) fn none_match(headers: &HeaderMap, etag: &str) -> bool {
    let opaque = |tag: &str| tag.trim().trim_start_matches("W/").to_owned();
    let etag = opaque(etag);
    headers.get_all(IF_NONE_MATCH).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .any(|tag| tag.trim() == "*" || opaque(tag) == etag)
        })
    })
}

/// The single byte range a request asks for, inclusive, within `size`.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RangeRequest {
    /// No usable `Range`: serve the whole representation.
    Whole,
    Satisfiable {
        start: u64,
        end: u64,
    },
    Unsatisfiable,
}

/// Parse `Range` for a representation of `size` bytes. Several ranges, other
/// units and an `If-Range` that does not match `etag` serve the whole body.
pub(super) fn range(headers: &HeaderMap, size: u64, etag: &str) -> RangeRequest {
    let Some(value) = headers.get(RANGE).and_then(|value| value.to_str().ok()) else {
        return RangeRequest::Whole;
    };
    if let Some(if_range) = headers.get(IF_RANGE) {
        // Only strong validators qualify; dates are not offered.
        if if_range.to_str().ok().map(str::trim) != Some(etag) {
            return RangeRequest::Whole;
        }
    }
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return RangeRequest::Whole;
    };
    if spec.contains(',') {
        return RangeRequest::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return RangeRequest::Whole;
    };
    let parse = |text: &str| -> Option<u64> {
        (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| text.parse().ok())
            .flatten()
    };
    match (first.trim(), last.trim()) {
        ("", suffix) => match parse(suffix) {
            Some(0) => RangeRequest::Unsatisfiable,
            Some(_) if size == 0 => RangeRequest::Unsatisfiable,
            Some(length) => RangeRequest::Satisfiable {
                start: size.saturating_sub(length),
                end: size - 1,
            },
            None => RangeRequest::Whole,
        },
        (first, last) => {
            let Some(start) = parse(first) else {
                return RangeRequest::Whole;
            };
            let end = if last.is_empty() {
                None
            } else {
                match parse(last) {
                    Some(end) if end >= start => Some(end),
                    _ => return RangeRequest::Whole,
                }
            };
            if start >= size {
                return RangeRequest::Unsatisfiable;
            }
            RangeRequest::Satisfiable {
                start,
                end: end.map_or(size - 1, |end| end.min(size - 1)),
            }
        }
    }
}

/// Percent-decode a URL path; `None` when the result is not UTF-8 or an
/// escape is malformed.
pub(super) fn decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            decoded.push(value);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn headers(pairs: &[(http::HeaderName, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(name.clone(), HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn brotli_needs_a_nonzero_weight() {
        let accept = |value| accepts_brotli(&headers(&[(ACCEPT_ENCODING, value)]));
        assert!(accept("gzip, deflate, br, zstd"));
        assert!(accept("BR;q=0.5"));
        assert!(accept("*"));
        assert!(!accept("gzip, deflate"));
        assert!(!accept("br;q=0"));
        assert!(!accept("br;q=0, *"));
        assert!(!accept("*;q=0"));
        assert!(!accepts_brotli(&HeaderMap::new()));
    }

    #[test]
    fn if_none_match_compares_weakly() {
        let matches = |value| none_match(&headers(&[(IF_NONE_MATCH, value)]), "\"abc\"");
        assert!(matches("\"abc\""));
        assert!(matches("W/\"abc\""));
        assert!(matches("\"x\", \"abc\""));
        assert!(matches("*"));
        assert!(!matches("\"abc-br\""));
    }

    #[test]
    fn ranges_are_single_byte_ranges() {
        let range_of = |value, size| range(&headers(&[(RANGE, value)]), size, "\"e\"");
        use RangeRequest::*;
        assert_eq!(range_of("bytes=0-3", 10), Satisfiable { start: 0, end: 3 });
        assert_eq!(range_of("bytes=4-", 10), Satisfiable { start: 4, end: 9 });
        assert_eq!(range_of("bytes=-3", 10), Satisfiable { start: 7, end: 9 });
        assert_eq!(range_of("bytes=-30", 10), Satisfiable { start: 0, end: 9 });
        assert_eq!(
            range_of("bytes=5-100", 10),
            Satisfiable { start: 5, end: 9 }
        );
        assert_eq!(range_of("bytes=10-", 10), Unsatisfiable);
        assert_eq!(range_of("bytes=-0", 10), Unsatisfiable);
        assert_eq!(range_of("bytes=0-1,4-5", 10), Whole);
        assert_eq!(range_of("bytes=5-1", 10), Whole);
        assert_eq!(range_of("items=0-1", 10), Whole);
        assert_eq!(range_of("bytes=+1-2", 10), Whole);
        let stale = headers(&[(RANGE, "bytes=0-1"), (IF_RANGE, "\"old\"")]);
        assert_eq!(range(&stale, 10, "\"e\""), Whole);
    }

    #[test]
    fn paths_are_percent_decoded() {
        assert_eq!(decode_path("/a%20b/%E3%81%82").as_deref(), Some("/a b/あ"));
        assert_eq!(decode_path("/%zz"), None);
        assert_eq!(decode_path("/%ff"), None);
        assert_eq!(decode_path("/%2"), None);
    }
}
