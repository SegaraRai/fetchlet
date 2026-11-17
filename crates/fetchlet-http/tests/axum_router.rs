//! One axum Router serving public HTTP and in-process fetches.

use std::net::SocketAddr;
use std::num::NonZeroUsize;

use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::routing::get;
use axum::{Extension, Router};
use tower::ServiceExt;

use fetchlet::{App, Backend, Context, HostServices, Module, OriginRouter, WorkerOptions};
use fetchlet_http::{AxumService, router_transport};

const SOURCE: &str = include_str!("fixtures/router.js");

fn backends() -> Vec<Backend> {
    vec![Backend::quickjs(), Backend::Boa, Backend::v8()]
}

#[derive(Clone)]
struct Caller(String);

async fn whoami(context: Option<Extension<Context>>) -> String {
    context
        .as_ref()
        .and_then(|Extension(context)| context.get::<Caller>())
        .map_or("anonymous".to_owned(), |Caller(name)| name.clone())
}

fn services() -> fetchlet::Result<HostServices> {
    Ok(HostServices::new().outbound(
        OriginRouter::new()
            .internal("https://api.test", router_transport(api()))?
            .into_service(),
    ))
}

fn api() -> Router {
    Router::new().route("/whoami", get(whoami))
}

async fn text(response: axum::response::Response) -> anyhow::Result<(u16, String)> {
    let status = response.status().as_u16();
    let body = to_bytes(response.into_body(), 1024).await?;
    Ok((status, String::from_utf8(body.to_vec())?))
}

#[tokio::test(flavor = "current_thread")]
async fn one_router_serves_http_and_in_process_fetches() -> anyhow::Result<()> {
    let public = api()
        .oneshot(Request::builder().uri("/whoami").body(Body::empty())?)
        .await?;
    assert_eq!(text(public).await?, (200, "anonymous".into()));

    for backend in backends() {
        let mut app = App::builder(backend)
            .module(Module::new(SOURCE))
            .host_services(services()?)
            .build()?;

        for (path, expected) in [
            ("/whoami", (200, "alice".to_owned())),
            ("/missing", (404, String::new())),
        ] {
            let mut request = Request::builder()
                .uri(format!("https://app.test/fetch?to=https://api.test{path}"))
                .body(fetchlet::Body::empty())?;
            request
                .extensions_mut()
                .insert(Context::new().with(Caller("alice".into())));
            let response = app.fetch(request).await?;
            assert_eq!(text(response.map(Body::new)).await?, expected, "{path}");
        }
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn the_trusted_context_comes_from_the_incoming_request() -> anyhow::Result<()> {
    for backend in backends() {
        let handle = App::builder(backend)
            .module(Module::new(SOURCE))
            .host_services(services()?)
            .spawn(WorkerOptions::new(NonZeroUsize::new(2).unwrap()))
            .await?;
        let service =
            AxumService::new(handle.clone(), "https://app.test")?.trusted_context(|parts| {
                let address = parts
                    .extensions
                    .get::<ConnectInfo<SocketAddr>>()
                    .map_or("unknown".to_owned(), |ConnectInfo(address)| {
                        address.ip().to_string()
                    });
                Context::new().with(Caller(address))
            });
        let mut request = Request::builder()
            .uri("/fetch?to=https://api.test/whoami")
            .body(Body::empty())?;
        request
            .extensions_mut()
            .insert(ConnectInfo("192.0.2.4:1234".parse::<SocketAddr>()?));
        let response = service.clone().oneshot(request).await?;
        assert_eq!(text(response).await?, (200, "192.0.2.4".into()));

        // Without the factory, in-process routes see no Context.
        let plain = AxumService::new(handle.clone(), "https://app.test")?;
        let request = Request::builder()
            .uri("/fetch?to=https://api.test/whoami")
            .body(Body::empty())?;
        let response = plain.oneshot(request).await?;
        assert_eq!(text(response).await?, (200, "anonymous".into()));
        handle.shutdown().await?;
    }
    Ok(())
}
