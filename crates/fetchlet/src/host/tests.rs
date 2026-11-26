use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http::{Method, header};

use super::*;
use crate::{Body, Error, Limits, Request, Response};

fn request(url: &str) -> Request {
    http::Request::builder()
        .uri(url)
        .body(Body::empty())
        .unwrap()
}

fn response(status: u16, location: Option<&str>) -> Response {
    let mut builder = http::Response::builder().status(status);
    if let Some(location) = location {
        builder = builder.header(header::LOCATION, location);
    }
    builder.body(Body::empty()).unwrap()
}

fn policy() -> FetchPolicy {
    FetchPolicy::deny_all()
        .allow_origin("https://allowed.test")
        .unwrap()
}

#[test]
fn origins_are_exact_and_canonical() {
    let policy = policy();
    for url in ["https://allowed.test/", "https://ALLOWED.test:443/path?q=1"] {
        assert!(policy.check(&request(url)).is_ok(), "{url}");
    }
    for url in [
        "http://allowed.test/",
        "https://allowed.test:444/",
        "https://allowed.test.evil/",
        "https://evil.test/",
        "http://127.0.0.1/",
    ] {
        assert!(
            matches!(policy.check(&request(url)), Err(Error::PermissionDenied)),
            "{url}"
        );
    }
    for origin in [
        "https://allowed.test/path",
        "https://allowed.test/?q=1",
        "https://user:secret@allowed.test/",
        "file:///tmp/file",
    ] {
        assert!(
            FetchPolicy::deny_all().allow_origin(origin).is_err(),
            "{origin}"
        );
    }
}

#[test]
fn forbidden_methods_are_rejected_regardless_of_case() {
    for method in ["CONNECT", "connect", "Trace", "tRaCk"] {
        let request = http::Request::builder()
            .uri("https://allowed.test/")
            .method(method)
            .body(Body::empty())
            .unwrap();

        assert!(matches!(
            policy().check(&request),
            Err(Error::PermissionDenied)
        ));
    }
}

#[tokio::test]
async fn rewritten_destination_is_checked_before_transport_or_credentials() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sent = calls.clone();
    let credentials = calls.clone();
    let service = FetchService::new(
        transport_fn(move |_| {
            sent.fetch_add(1, Ordering::SeqCst);
            async { Ok(response(200, None)) }
        }),
        policy(),
    )
    .rewrite(|req| {
        *req.uri_mut() = "http://127.0.0.1/private".parse().unwrap();
        Ok(())
    })
    .credentials(move |_, _| {
        credentials.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    assert!(matches!(
        service
            .execute(
                request("https://allowed.test/"),
                Redirect::Follow,
                Limits::default()
            )
            .await,
        Err(Error::PermissionDenied)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn every_redirect_is_authorized() {
    let calls = Arc::new(AtomicUsize::new(0));
    let sent = calls.clone();
    let service = FetchService::new(
        transport_fn(move |_| {
            sent.fetch_add(1, Ordering::SeqCst);
            async { Ok(response(302, Some("http://127.0.0.1/private"))) }
        }),
        policy(),
    );
    assert!(matches!(
        service
            .execute(
                request("https://allowed.test/"),
                Redirect::Follow,
                Limits::default()
            )
            .await,
        Err(Error::PermissionDenied)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn credentials_do_not_propagate_to_a_different_origin() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let capture = seen.clone();
    let policy = policy().allow_origin("https://other.test").unwrap();
    let service = FetchService::new(
        transport_fn(move |req| {
            let first = req.uri().host() == Some("allowed.test");
            capture.lock().unwrap().push(req.headers().clone());
            async move {
                Ok(if first {
                    response(302, Some("https://other.test/"))
                } else {
                    response(200, None)
                })
            }
        }),
        policy,
    )
    .credentials(|url, headers| {
        if url.host_str() == Some("allowed.test") {
            headers.insert("x-api-key", http::HeaderValue::from_static("secret"));
        }
        Ok(())
    });
    let mut req = request("https://allowed.test/");
    req.headers_mut().insert(
        header::AUTHORIZATION,
        http::HeaderValue::from_static("Bearer guest"),
    );
    req.headers_mut().insert(
        header::COOKIE,
        http::HeaderValue::from_static("session=guest"),
    );
    service
        .execute(req, Redirect::Follow, Limits::default())
        .await
        .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0]["x-api-key"], "secret");
    assert!(!seen[1].contains_key("x-api-key"));
    assert!(!seen[1].contains_key(header::AUTHORIZATION));
    assert!(!seen[1].contains_key(header::COOKIE));
}

#[tokio::test]
async fn redirect_modes_and_hop_limits() {
    for (redirect, passes, expected_calls) in [
        (Redirect::Manual, true, 1),
        (Redirect::Error, false, 1),
        (Redirect::Follow, false, 3),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let capture = calls.clone();
        let service = FetchService::new(
            transport_fn(move |_| {
                capture.fetch_add(1, Ordering::SeqCst);
                async { Ok(response(302, Some("/loop"))) }
            }),
            policy(),
        );
        let limits = Limits {
            redirects: Some(2),
            ..Limits::default()
        };
        assert_eq!(
            service
                .execute(request("https://allowed.test/"), redirect, limits)
                .await
                .is_ok(),
            passes
        );
        assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
    }
}

#[tokio::test]
async fn post_redirect_semantics_and_transport_headers() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let capture = seen.clone();
    let service = FetchService::new(
        transport_fn(move |req| {
            let first = req.uri().path() == "/start";
            capture.lock().unwrap().push((
                req.method().clone(),
                req.body().buffered().unwrap().to_vec(),
                req.headers().clone(),
            ));
            async move {
                Ok(if first {
                    response(303, Some("/next"))
                } else {
                    response(200, None)
                })
            }
        }),
        policy(),
    );
    let req = http::Request::builder()
        .uri("https://allowed.test/start")
        .method("POST")
        .header("content-type", "text/plain")
        .header("content-length", "999")
        .header("host", "evil.test")
        .body(Body::from("payload"))
        .unwrap();
    service
        .execute(req, Redirect::Follow, Limits::default())
        .await
        .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].0, Method::POST);
    assert!(!seen[0].2.contains_key("host"));
    assert!(!seen[0].2.contains_key("content-length"));
    assert_eq!(seen[1].0, Method::GET);
    assert!(seen[1].1.is_empty());
    assert!(!seen[1].2.contains_key("content-type"));
}

#[tokio::test]
async fn response_and_request_limits_are_enforced() {
    let calls = Arc::new(AtomicUsize::new(0));
    let capture = calls.clone();
    let service = FetchService::new(
        transport_fn(move |_| {
            capture.fetch_add(1, Ordering::SeqCst);
            async { Ok(Response::new(Body::from("too large"))) }
        }),
        policy(),
    );
    let limits = Limits {
        request_body_bytes: Some(2),
        response_body_bytes: Some(2),
        ..Limits::default()
    };
    let req = http::Request::builder()
        .uri("https://allowed.test/")
        .method("POST")
        .body(Body::from("long"))
        .unwrap();
    assert!(matches!(
        service.execute(req, Redirect::Follow, limits.clone()).await,
        Err(Error::LimitExceeded(_))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        service
            .execute(request("https://allowed.test/"), Redirect::Follow, limits)
            .await,
        Err(Error::LimitExceeded(_))
    ));
}

#[test]
fn binding_names_cannot_shadow_services_or_use_prototype_tricks() {
    let hosts = HostServices::new().env("MODE", "test").unwrap();
    assert!(hosts.clone().env("MODE", "again").is_err());
    assert!(hosts.env("property.name", "test").is_ok());
    // JS bindings use a null-prototype object, so these are ordinary names.
    assert!(HostServices::new().env("__proto__", "value").is_ok());
}

#[tokio::test]
async fn caller_can_set_body_budgets_above_one_mebibyte() {
    let body_size = 2 * 1024 * 1024;
    let service = FetchService::new(
        transport_fn(move |request| async move {
            let body = request.into_body().collect(body_size).await?;
            Ok(Response::new(Body::from(body)))
        }),
        policy(),
    );
    let limits = Limits {
        request_body_bytes: Some(body_size),
        response_body_bytes: Some(body_size),
        timeout: Some(Duration::from_secs(7200)),
        ..Limits::default()
    };
    let request = http::Request::builder()
        .method("POST")
        .uri("https://allowed.test/")
        .body(Body::from(vec![42; body_size]))
        .unwrap();

    let response = service.fetch(request, limits).await.unwrap();
    assert_eq!(
        response.into_body().collect(body_size).await.unwrap().len(),
        body_size
    );
}

#[tokio::test]
async fn fetch_redirect_algorithm_terminates_at_its_specification_limit() {
    let calls = Arc::new(AtomicUsize::new(0));
    let captured = calls.clone();
    let service = FetchService::new(
        transport_fn(move |_| {
            captured.fetch_add(1, Ordering::SeqCst);
            async { Ok(response(302, Some("/again"))) }
        }),
        policy(),
    );

    let result = service
        .fetch(request("https://allowed.test/"), Limits::default())
        .await;
    assert!(matches!(result, Err(Error::LimitExceeded("redirect hops"))));
    assert_eq!(calls.load(Ordering::SeqCst), 21);
}

#[derive(Clone)]
struct Marker(&'static str);

fn with_context(url: &str) -> Request {
    let mut request = request(url);
    request
        .extensions_mut()
        .insert(Context::new().with(Marker("trusted")));
    request
}

/// A transport that answers "/start" with a redirect to "/end" and records
/// whether each hop carried the Context.
fn recording(seen: Arc<Mutex<Vec<bool>>>) -> impl FetchTransport {
    transport_fn(move |req: Request| {
        let carried = Context::of(&req).and_then(|context| context.get::<Marker>());
        seen.lock()
            .unwrap()
            .push(carried.is_some_and(|Marker(value)| *value == "trusted"));
        let redirect = req.uri().path() == "/start";
        async move {
            Ok(if redirect {
                response(302, Some("/end"))
            } else {
                response(200, None)
            })
        }
    })
}

#[tokio::test]
async fn the_context_is_withheld_unless_forwarded() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let plain = FetchService::new(recording(seen.clone()), policy());
    plain
        .fetch(
            with_context("https://allowed.test/start"),
            Limits::default(),
        )
        .await
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), [false, false]);

    seen.lock().unwrap().clear();
    let forwarding = plain.forward_context();
    forwarding
        .fetch(
            with_context("https://allowed.test/start"),
            Limits::default(),
        )
        .await
        .unwrap();
    // Each hop of a followed redirect carries it.
    assert_eq!(*seen.lock().unwrap(), [true, true]);
}

#[tokio::test]
async fn routed_origins_are_exact_and_scope_the_context() {
    let internal = Arc::new(Mutex::new(Vec::new()));
    let external = Arc::new(Mutex::new(Vec::new()));
    let service = OriginRouter::new()
        .internal("https://fetchlet.internal", recording(internal.clone()))
        .unwrap()
        .external("https://EXTERNAL.test:443", recording(external.clone()))
        .unwrap()
        .into_service();

    for url in [
        "https://fetchlet.internal/start",
        "https://external.test/start",
    ] {
        service
            .fetch(with_context(url), Limits::default())
            .await
            .unwrap();
    }
    assert_eq!(*internal.lock().unwrap(), [true, true]);
    assert_eq!(*external.lock().unwrap(), [false, false]);

    for url in [
        "http://fetchlet.internal/",
        "https://fetchlet.internal:8443/",
        "https://other.test/",
    ] {
        assert!(matches!(
            service.fetch(with_context(url), Limits::default()).await,
            Err(Error::PermissionDenied)
        ));
    }
    assert_eq!(internal.lock().unwrap().len(), 2);

    assert!(matches!(
        OriginRouter::new()
            .internal("https://fetchlet.internal", recording(internal.clone()))
            .unwrap()
            .external("https://fetchlet.internal/", recording(external.clone())),
        Err(Error::Configuration(_))
    ));
    assert!(
        OriginRouter::new()
            .internal("https://fetchlet.internal/api", recording(internal))
            .is_err()
    );
}

/// A request body that streams: chunks without a source to read again.
struct Chunks(std::collections::VecDeque<bytes::Bytes>);

impl http_body::Body for Chunks {
    type Data = bytes::Bytes;
    type Error = Error;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<crate::Result<http_body::Frame<bytes::Bytes>>>> {
        std::task::Poll::Ready(
            self.0
                .pop_front()
                .map(|chunk| Ok(http_body::Frame::data(chunk))),
        )
    }
}

fn streamed(url: &str, chunks: &[&'static str]) -> Request {
    let body = Chunks(
        chunks
            .iter()
            .map(|chunk| bytes::Bytes::from_static(chunk.as_bytes()))
            .collect(),
    );
    http::Request::builder()
        .uri(url)
        .method("POST")
        .body(Body::from_http_body(body))
        .unwrap()
}

/// A transport that reads each body as it streams and answers each path
/// with the redirect status it names, such as `/307`, or 200.
/// Each request a transport saw: its method, its body and whether it had to
/// use HTTP/2.
type Sent = Arc<Mutex<Vec<(Method, Vec<u8>, bool)>>>;

fn redirecting(seen: Sent) -> impl FetchTransport {
    transport_fn(move |req: Request| {
        let seen = seen.clone();
        async move {
            let status: u16 = req.uri().path()[1..].parse().unwrap_or(200);
            let http2 = req.extensions().get::<RequireHttp2>().is_some();
            let (parts, body) = req.into_parts();
            let body = body.collect(1024).await?;
            seen.lock()
                .unwrap()
                .push((parts.method, body.to_vec(), http2));
            Ok(if status == 200 {
                response(200, None)
            } else {
                response(status, Some("/200"))
            })
        }
    })
}

#[tokio::test]
async fn streamed_bodies_are_sent_once_and_follow_only_303() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let service = FetchService::new(redirecting(seen.clone()), policy());
    let limits = Limits::default();

    service
        .execute(
            streamed("https://allowed.test/200", &["a", "b"]),
            Redirect::Follow,
            limits.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        seen.lock().unwrap().pop().unwrap(),
        (Method::POST, b"ab".to_vec(), true)
    );

    // A 303 continues as a GET without the body, which no longer streams.
    service
        .execute(
            streamed("https://allowed.test/303", &["a"]),
            Redirect::Follow,
            limits.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::mem::take(&mut *seen.lock().unwrap()),
        vec![
            (Method::POST, b"a".to_vec(), true),
            (Method::GET, Vec::new(), false)
        ]
    );

    // Every other redirect would resend it, so the fetch fails after one hop.
    for status in [301, 302, 307, 308] {
        let result = service
            .execute(
                streamed(&format!("https://allowed.test/{status}"), &["a"]),
                Redirect::Follow,
                limits.clone(),
            )
            .await;
        assert!(matches!(result, Err(Error::Transport(_))), "{status}");
        assert_eq!(seen.lock().unwrap().len(), 1, "{status}");
        seen.lock().unwrap().clear();
    }
    // Manual mode returns the redirect itself.
    let response = service
        .execute(
            streamed("https://allowed.test/307", &["a"]),
            Redirect::Manual,
            limits.clone(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 307);

    // A buffered body is resent.
    seen.lock().unwrap().clear();
    let buffered = http::Request::builder()
        .uri("https://allowed.test/307")
        .method("POST")
        .body(Body::from("x"))
        .unwrap();
    service
        .execute(buffered, Redirect::Follow, limits)
        .await
        .unwrap();
    assert_eq!(
        std::mem::take(&mut *seen.lock().unwrap()),
        vec![
            (Method::POST, b"x".to_vec(), false),
            (Method::POST, b"x".to_vec(), false)
        ]
    );
}

#[tokio::test]
async fn the_policy_can_let_streamed_bodies_use_http1() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let service = FetchService::new(redirecting(seen.clone()), policy().allow_http1_streaming());
    service
        .execute(
            streamed("https://allowed.test/200", &["a"]),
            Redirect::Follow,
            Limits::default(),
        )
        .await
        .unwrap();
    assert!(!seen.lock().unwrap()[0].2);
}

#[tokio::test]
async fn streamed_bodies_count_against_the_request_budget_as_they_are_read() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let service = FetchService::new(redirecting(seen.clone()), policy());
    let limits = Limits {
        request_body_bytes: Some(3),
        ..Limits::default()
    };
    service
        .execute(
            streamed("https://allowed.test/200", &["ab", "c"]),
            Redirect::Follow,
            limits.clone(),
        )
        .await
        .unwrap();
    assert!(matches!(
        service
            .execute(
                streamed("https://allowed.test/200", &["ab", "cd"]),
                Redirect::Follow,
                limits
            )
            .await,
        Err(Error::LimitExceeded("request body bytes"))
    ));
}

#[test]
fn process_env_binds_both_env_and_process_env_without_duplicates() {
    let hosts = HostServices::new()
        .env("PRIVATE", "secret")
        .unwrap()
        .process_env("PUBLIC_KEY", "abc")
        .unwrap();
    assert_eq!(hosts.env.get("PRIVATE").map(String::as_str), Some("secret"));
    assert_eq!(hosts.env.get("PUBLIC_KEY").map(String::as_str), Some("abc"));
    assert!(!hosts.process_env.contains_key("PRIVATE"));
    assert_eq!(
        hosts.process_env.get("PUBLIC_KEY").map(String::as_str),
        Some("abc")
    );
    assert!(matches!(
        hosts.clone().process_env("PRIVATE", "dup"),
        Err(Error::Configuration(_))
    ));
}
