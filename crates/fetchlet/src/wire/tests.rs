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
        body: WireBytes::Inline(vec![0, 128, 255]),
        stream: None,
    };

    let limits = Limits::default();
    let response = response.into_http(&limits, &mut InlineBytes).unwrap();
    let round_trip = WireResponse::from_http(response, &limits, &mut InlineBytes).unwrap();

    assert_eq!(round_trip.body, WireBytes::Inline(vec![0, 128, 255]));
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
            body: WireBytes::default(),
            stream: None,
        };

        assert!(matches!(
            response.into_http(&Limits::default(), &mut InlineBytes),
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
            body: WireBytes::Inline(body),
            stream: None,
        };

        assert!(
            response
                .into_http(&Limits::default(), &mut InlineBytes)
                .is_err()
        );
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
fn an_open_stream_on_a_null_body_status_is_rejected() {
    let response = WireResponse {
        status: 204,
        headers: Vec::new(),
        body: WireBytes::default(),
        stream: Some(1),
    };

    assert!(
        response
            .into_http(&Limits::default(), &mut InlineBytes)
            .is_err()
    );
}

#[tokio::test]
async fn a_streaming_request_body_is_collected_within_the_request_budget() {
    let limits = Limits {
        request_body_bytes: Some(4),
        ..Limits::default()
    };
    let (sender, body) = Body::channel(bytes::Bytes::from_static(b"ab"), 2);
    sender
        .send(Ok((bytes::Bytes::from_static(b"cd"), false)))
        .await
        .unwrap();
    sender
        .send(Ok((bytes::Bytes::from_static(b"e"), true)))
        .await
        .unwrap();
    let request = http::Request::builder()
        .method(Method::POST)
        .uri("https://example.test/")
        .body(body)
        .unwrap();

    assert!(matches!(
        WireRequest::from_http(request, &limits, &mut InlineBytes).await,
        Err(Error::LimitExceeded("request body bytes"))
    ));
}

#[tokio::test]
async fn request_url_budget_applies_in_both_directions() {
    let limits = Limits {
        url_bytes: Some(8),
        ..Limits::default()
    };
    let request = http::Request::builder()
        .uri("https://example.test/path")
        .body(Body::empty())
        .unwrap();
    assert!(matches!(
        WireRequest::from_http(request, &limits, &mut InlineBytes).await,
        Err(Error::LimitExceeded("URL bytes"))
    ));

    let wire = WireRequest {
        url: "https://example.test/path".into(),
        method: "GET".into(),
        headers: Vec::new(),
        body: None,
        stream: None,
    };
    assert!(matches!(
        wire.into_http(&limits, &mut InlineBytes),
        Err(Error::LimitExceeded("URL bytes"))
    ));
}

#[test]
fn byte_handles_are_taken_once_within_their_store() {
    let mut store = ByteStore::default();
    let handle = store.send(bytes::Bytes::from_static(b"abc")).unwrap();
    assert_eq!(handle, WireBytes::Handle(1));
    assert_eq!(store.receive(handle.clone()).unwrap().as_ref(), b"abc");
    assert!(matches!(
        store.receive(handle),
        Err(Error::InvalidRequest(_))
    ));
    assert!(matches!(
        InlineBytes.receive(WireBytes::Handle(1)),
        Err(Error::InvalidRequest(_))
    ));
}

#[test]
fn wire_bodies_accept_handles_and_inline_arrays() {
    let handle: WireBytes = serde_json::from_str("7").unwrap();
    let inline: WireBytes = serde_json::from_str("[1,2]").unwrap();
    assert_eq!(handle, WireBytes::Handle(7));
    assert_eq!(inline, WireBytes::Inline(vec![1, 2]));
    assert!(serde_json::from_str::<WireBytes>("[256]").is_err());
}
