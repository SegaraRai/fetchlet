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
                req.body().buffered().to_vec(),
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
