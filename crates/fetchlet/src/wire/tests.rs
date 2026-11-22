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
        upgrade: None,
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
            upgrade: None,
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
            upgrade: None,
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
        upgrade: None,
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

fn wire_request(method: &str, body: Option<WireBytes>) -> WireRequest {
    WireRequest {
        url: "https://example.test/".into(),
        method: method.into(),
        headers: Vec::new(),
        body,
        stream: None,
    }
}

fn http_request(method: &str, body: &'static [u8]) -> crate::Request {
    http::Request::builder()
        .method(method)
        .uri("https://example.test/")
        .body(Body::from(bytes::Bytes::from_static(body)))
        .unwrap()
}

#[tokio::test]
async fn forbidden_methods_are_refused_in_both_directions() {
    let limits = Limits::default();
    for method in ["CONNECT", "trace", "Track"] {
        assert!(matches!(
            wire_request(method, None).into_http(&limits, &mut InlineBytes),
            Err(Error::PermissionDenied)
        ));
        assert!(matches!(
            WireRequest::from_http(http_request(method, b""), &limits, &mut InlineBytes).await,
            Err(Error::PermissionDenied)
        ));
    }
}

#[tokio::test]
async fn get_and_head_bodies_are_refused_in_both_directions() {
    let limits = Limits::default();
    for method in ["GET", "head"] {
        assert!(matches!(
            wire_request(method, Some(WireBytes::Inline(vec![1])))
                .into_http(&limits, &mut InlineBytes),
            Err(Error::InvalidRequest(_))
        ));
        assert!(matches!(
            WireRequest::from_http(http_request(method, b"x"), &limits, &mut InlineBytes).await,
            Err(Error::InvalidRequest(_))
        ));
    }
    let empty = wire_request("GET", Some(WireBytes::Inline(Vec::new())))
        .into_http(&limits, &mut InlineBytes)
        .unwrap();
    assert_eq!(empty.method(), Method::GET);
}

#[test]
fn outbound_requests_carry_buffered_bodies_only() {
    let mut wire = wire_request("POST", None);
    wire.stream = Some(1);
    assert!(matches!(
        wire.into_http(&Limits::default(), &mut InlineBytes),
        Err(Error::InvalidRequest(_))
    ));
}

#[tokio::test]
async fn request_bodies_cross_a_byte_store_as_handles() {
    let limits = Limits::default();
    let mut store = ByteStore::default();
    let wire = WireRequest::from_http(http_request("post", b"payload"), &limits, &mut store)
        .await
        .unwrap();
    assert_eq!(wire.method, "POST");
    assert_eq!(wire.body, Some(WireBytes::Handle(1)));
    let request = wire.into_http(&limits, &mut store).unwrap();
    assert_eq!(
        request.into_body().into_bytes().unwrap().as_ref(),
        b"payload"
    );

    let empty = WireRequest::from_http(http_request("POST", b""), &limits, &mut store)
        .await
        .unwrap();
    assert_eq!(empty.body, None);
}

#[tokio::test]
async fn header_budgets_count_names_and_values_in_both_directions() {
    let limits = Limits {
        header_bytes: Some(8),
        ..Limits::default()
    };
    let mut wire = wire_request("GET", None);
    wire.headers = vec![("abcd".into(), "1234".into())];
    assert!(wire.into_http(&limits, &mut InlineBytes).is_ok());
    let mut wire = wire_request("GET", None);
    wire.headers = vec![("abcd".into(), "12345".into())];
    assert!(matches!(
        wire.into_http(&limits, &mut InlineBytes),
        Err(Error::LimitExceeded("header bytes"))
    ));

    let mut request = http_request("GET", b"");
    request
        .headers_mut()
        .insert("abcd", http::HeaderValue::from_static("12345"));
    assert!(matches!(
        WireRequest::from_http(request, &limits, &mut InlineBytes).await,
        Err(Error::LimitExceeded("header bytes"))
    ));
}

#[tokio::test]
async fn opaque_header_bytes_are_not_passed_to_javascript() {
    let opaque = http::HeaderValue::from_bytes(b"caf\xe9").unwrap();
    let mut request = http_request("GET", b"");
    request.headers_mut().insert("x-name", opaque.clone());
    assert!(matches!(
        WireRequest::from_http(request, &Limits::default(), &mut InlineBytes).await,
        Err(Error::InvalidRequest(_))
    ));

    let mut response = crate::Response::new(Body::empty());
    response.headers_mut().insert("x-name", opaque);
    assert!(matches!(
        WireResponse::from_http(response, &Limits::default(), &mut InlineBytes),
        Err(Error::InvalidRequest(_))
    ));
}

#[test]
fn response_body_budget_applies_in_both_directions() {
    let limits = Limits {
        response_body_bytes: Some(2),
        ..Limits::default()
    };
    let wire = WireResponse {
        status: 200,
        headers: Vec::new(),
        body: WireBytes::Inline(vec![1, 2, 3]),
        stream: None,
        upgrade: None,
    };
    assert!(matches!(
        wire.into_http(&limits, &mut InlineBytes),
        Err(Error::LimitExceeded("response body bytes"))
    ));

    let response = crate::Response::new(Body::from(bytes::Bytes::from_static(b"abc")));
    assert!(matches!(
        WireResponse::from_http(response, &limits, &mut InlineBytes),
        Err(Error::LimitExceeded("response body bytes"))
    ));
}

#[test]
fn null_body_responses_drop_an_unread_stream_but_refuse_buffered_bytes() {
    let limits = Limits::default();
    let (_sender, body) = Body::channel(bytes::Bytes::new(), 1);
    let mut response = crate::Response::new(body);
    *response.status_mut() = http::StatusCode::NOT_MODIFIED;
    let wire = WireResponse::from_http(response, &limits, &mut InlineBytes).unwrap();
    assert_eq!((wire.body, wire.stream), (WireBytes::default(), None));

    let mut response = crate::Response::new(Body::from(bytes::Bytes::from_static(b"x")));
    *response.status_mut() = http::StatusCode::NO_CONTENT;
    assert!(matches!(
        WireResponse::from_http(response, &limits, &mut InlineBytes),
        Err(Error::InvalidRequest(_))
    ));
}

#[test]
fn wire_requests_refuse_unknown_fields() {
    let valid = r#"{"url":"https://example.test/","method":"GET","headers":[],"body":null}"#;
    assert!(serde_json::from_str::<WireRequest>(valid).is_ok());
    let extra =
        r#"{"url":"https://example.test/","method":"GET","headers":[],"body":null,"mode":"cors"}"#;
    assert!(serde_json::from_str::<WireRequest>(extra).is_err());
}

#[test]
fn a_guest_buffer_replaces_its_untaken_predecessor_only() {
    let mut store = ByteStore::default();
    let host = store.put(bytes::Bytes::from_static(b"host")).unwrap();
    let first = store.put_guest(bytes::Bytes::from_static(b"one")).unwrap();
    let second = store.put_guest(bytes::Bytes::from_static(b"two")).unwrap();
    assert!(matches!(store.take(first), Err(Error::InvalidRequest(_))));
    assert_eq!(store.take(second).unwrap().as_ref(), b"two");
    assert_eq!(store.take(host).unwrap().as_ref(), b"host");

    let taken = store
        .put_guest(bytes::Bytes::from_static(b"three"))
        .unwrap();
    assert_eq!(store.take(taken).unwrap().as_ref(), b"three");
    let next = store.put_guest(bytes::Bytes::from_static(b"four")).unwrap();
    assert_eq!(store.take(next).unwrap().as_ref(), b"four");
}
