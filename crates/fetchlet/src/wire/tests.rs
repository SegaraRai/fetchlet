use http::Method;

use super::codec::headers_from_wire;
use super::*;
use crate::{Body, Error, Limits};

#[test]
fn binary_response_and_repeated_cookies_survive_conversion() {
    let response = WireResponse {
        status: 200,
        headers: vec![
            ("set-cookie".into(), "first=1".into()),
            ("set-cookie".into(), "second=2".into()),
        ],
        body: vec![0, 128, 255],
    };

    let limits = Limits::default();
    let response = response.into_http(&limits).unwrap();
    let round_trip = WireResponse::from_http(response, &limits).unwrap();

    assert_eq!(round_trip.body, vec![0, 128, 255]);
    assert_eq!(round_trip.headers.len(), 2);
    assert_eq!(round_trip.headers[0].1, "first=1");
    assert_eq!(round_trip.headers[1].1, "second=2");
}

#[test]
fn invalid_guest_headers_do_not_reach_http() {
    for headers in [
        vec![("bad\nname".into(), "value".into())],
        vec![("x-test".into(), "value\r\nInjected: yes".into())],
        vec![("x-test".into(), "\0".into())],
    ] {
        let response = WireResponse {
            status: 200,
            headers,
            body: Vec::new(),
        };

        assert!(matches!(
            response.into_http(&Limits::default()),
            Err(Error::InvalidRequest(_))
        ));
    }
}

#[test]
fn invalid_status_and_null_body_combinations_are_rejected() {
    for (status, body) in [(0, vec![]), (101, vec![]), (600, vec![]), (204, vec![1])] {
        let response = WireResponse {
            status,
            headers: Vec::new(),
            body,
        };

        assert!(response.into_http(&Limits::default()).is_err());
    }
}

#[test]
fn excessive_header_counts_return_an_error_without_panicking() {
    let headers = (0..40_000)
        .map(|index| (format!("x-{index}"), String::new()))
        .collect();

    assert!(headers_from_wire(headers, None).is_err());
}

#[test]
fn standard_methods_are_normalized_and_extension_methods_are_preserved() {
    for (input, expected) in [
        ("get", "GET"),
        ("pOsT", "POST"),
        ("patch", "patch"),
        ("Custom", "Custom"),
    ] {
        let method = Method::from_bytes(input.as_bytes()).unwrap();
        assert_eq!(normalize_fetch_method(&method).unwrap().as_str(), expected);
    }
}

#[test]
fn request_url_budget_applies_in_both_directions() {
    let limits = Limits {
        url_bytes: Some(8),
        ..Limits::default()
    };
    let request = http::Request::builder()
        .uri("https://example.test/path")
        .body(Body::empty())
        .unwrap();
    assert!(matches!(
        WireRequest::from_http(request, &limits),
        Err(Error::LimitExceeded("URL bytes"))
    ));

    let wire = WireRequest {
        url: "https://example.test/path".into(),
        method: "GET".into(),
        headers: Vec::new(),
        body: None,
    };
    assert!(matches!(
        wire.into_http(&limits),
        Err(Error::LimitExceeded("URL bytes"))
    ));
}
