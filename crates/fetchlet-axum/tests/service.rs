#![cfg(any(feature = "quickjs", feature = "boa", feature = "v8"))]

use std::num::NonZeroUsize;
use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::task::{Context, Poll};

use axum::body::{Body, Bytes, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use http_body::Frame;
use serde_json::json;
use tower::ServiceExt;

use fetchlet::{App, AppHandle, Backend, Limits, Module, WorkerOptions};
use fetchlet_axum::FetchletService;

const SOURCE: &str = include_str!("fixtures/handler.js");

fn backends() -> Vec<Backend> {
    vec![
        #[cfg(feature = "quickjs")]
        Backend::quickjs(),
        #[cfg(feature = "boa")]
        Backend::Boa,
        #[cfg(feature = "v8")]
        Backend::v8(),
    ]
}

async fn spawn(backend: Backend) -> fetchlet::Result<AppHandle> {
    App::builder(backend)
        .module(Module::new(SOURCE))
        .limits(Limits {
            request_body_bytes: Some(32),
            ..Limits::default()
        })
        .spawn(WorkerOptions::new(NonZeroUsize::new(2).unwrap()))
        .await
}

struct BrokenBody;

impl http_body::Body for BrokenBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        Poll::Ready(Some(Err(std::io::Error::other("connection interrupted"))))
    }
}

#[tokio::test(flavor = "current_thread")]
async fn binary_cookies_origin_and_request_context() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend).await?;
        let service = FetchletService::new(handle.clone(), "https://public.test:8443")?;
        let mut request = Request::builder()
            .method("POST")
            .uri("http://untrusted.test/echo?value=1")
            .header("host", "untrusted.test")
            .body(Body::from(vec![0, 128, 255]))?;
        request.extensions_mut().insert(ConnectInfo(
            "192.0.2.4:1234".parse::<std::net::SocketAddr>()?,
        ));
        let response = service.clone().oneshot(request).await?;
        assert_eq!(response.status(), 201);
        assert_eq!(
            response.headers()["x-url"],
            "https://public.test:8443/echo?value=1"
        );
        assert_eq!(response.headers()["x-method"], "POST");
        assert_eq!(response.headers()["x-address"], "192.0.2.4");
        assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
        assert_eq!(
            to_bytes(response.into_body(), 3).await?.as_ref(),
            &[0, 128, 255]
        );

        let service = service.context(|parts| {
            json!({
                "tenant": parts.headers["x-tenant"].to_str().unwrap(),
            })
        });
        let request = Request::builder()
            .uri("/context")
            .header("x-tenant", "example")
            .body(Body::empty())?;
        let response = service.oneshot(request).await?;
        assert_eq!(response.headers()["x-tenant"], "example");
        assert_eq!(response.headers()["x-address"], "none");
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn body_failures_are_classified_before_execution() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend).await?;
        let service = FetchletService::new(handle.clone(), "https://public.test")?;
        let oversized = Request::builder()
            .method("POST")
            .uri("/body")
            .body(Body::from(vec![0; 33]))?;
        assert_eq!(
            service.clone().oneshot(oversized).await?.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let broken = Request::builder()
            .method("POST")
            .uri("/body")
            .body(Body::new(BrokenBody))?;
        assert_eq!(
            service.clone().oneshot(broken).await?.status(),
            StatusCode::BAD_REQUEST
        );
        let valid = Request::builder().uri("/following").body(Body::empty())?;
        assert_eq!(service.oneshot(valid).await?.status(), 201);
        handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn error_details_stay_on_the_rust_side() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend).await?;
        let count = Arc::new(AtomicUsize::new(0));
        let errors = count.clone();
        let service =
            FetchletService::new(handle.clone(), "https://public.test")?.on_error(move |error| {
                assert!(error.to_string().contains("provider-private-detail"));
                errors.fetch_add(1, Ordering::SeqCst);
            });
        let request = Request::builder().uri("/failure").body(Body::empty())?;
        let response = service.oneshot(request).await?;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            to_bytes(response.into_body(), 64).await?,
            "Internal Server Error"
        );
        assert_eq!(count.load(Ordering::SeqCst), 1);
        handle.shutdown().await?;

        let service = FetchletService::new(handle, "https://public.test")?;
        let request = Request::builder().uri("/closed").body(Body::empty())?;
        assert_eq!(
            service.oneshot(request).await?.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn origin_configuration_is_validated() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = spawn(backend).await?;
        for invalid in [
            "example.test",
            "https://user:password@example.test",
            "https://example.test/path",
            "https://example.test?query=1",
            "https://example.test#fragment",
            "file://example.test",
        ] {
            assert!(
                FetchletService::new(handle.clone(), invalid).is_err(),
                "{invalid}"
            );
        }
        handle.shutdown().await?;
    }
    Ok(())
}
