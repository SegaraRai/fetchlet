//! Running a server module from a Vite dev server, against a stand-in for
//! `vite dev` with `fetchlet/vite`.

use std::num::NonZeroUsize;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::routing::get;
use tokio::net::TcpListener;
use tower::ServiceExt;

use fetchlet::{App, Backend, HostServices, Module, WorkerOptions};
use fetchlet_http::{AxumService, VITE_BINDING, ViteDev, ViteDevError, artifact_router};

const MANIFEST: &str = r#"{"format":"fetchlet-iife","formatVersion":1,"handler":"render","server":"server.js","backend":"quickjs"}"#;

/// A server module that renders every request as the app.
const SERVER: &str = r#"
globalThis.fetchletExports = {
  render() {
    const text = "from the app";
    return {
      status: 200,
      headers: [["content-type", "text/plain"]],
      body: Array.from(text, (c) => c.charCodeAt(0)),
    };
  },
};
"#;

/// A stand-in Vite dev server: the artifact, a module, and its own 404s.
async fn vite() -> String {
    let router = Router::new()
        .route(
            "/@fetchlet/artifact/fetchlet.json",
            get(|| async { MANIFEST }),
        )
        .route("/@fetchlet/artifact/server.js", get(|| async { SERVER }))
        .route("/src/client.ts", get(|| async { "from vite" }))
        .route("/@fetchlet/client", get(|| async { "client from vite" }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

async fn text(router: &Router, method: &str, uri: &str) -> (StatusCode, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn serves_vite_modules_in_front_of_the_development_artifact() -> anyhow::Result<()> {
    let vite = ViteDev::new(&vite().await)?;
    let artifact = vite.artifact().await?;
    assert_eq!(artifact.handler(), Some("render"));
    assert_eq!(artifact.client_directory(), None);

    let services = vite.host_services(HostServices::new())?;
    let app = App::builder(Backend::quickjs())
        .module(Module::new(artifact.server_source()?).requires(artifact.requirements()))
        .fetch_handler(artifact.handler())
        .host_services(services)
        .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
        .await?;
    let rendering = AxumService::new(app.clone(), "http://localhost")?;
    let router = Router::new().fallback_service(vite.proxy(artifact_router(&artifact, rendering)));

    assert_eq!(
        text(&router, "GET", "/src/client.ts").await,
        (StatusCode::OK, "from vite".into())
    );
    assert_eq!(
        text(&router, "GET", "/@fetchlet/client?entry=src%2Fclient.ts").await,
        (StatusCode::OK, "client from vite".into())
    );
    // Vite answers 404, so the app renders the page.
    assert_eq!(
        text(&router, "GET", "/about").await,
        (StatusCode::OK, "from the app".into())
    );
    // Only GET and HEAD reach Vite.
    assert_eq!(
        text(&router, "POST", "/src/client.ts").await,
        (StatusCode::OK, "from the app".into())
    );
    // The runner's endpoints are not reachable through the proxy.
    assert_eq!(
        text(&router, "GET", "/@fetchlet/artifact/server.js").await,
        (StatusCode::OK, "from the app".into())
    );
    app.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn reports_a_dev_server_without_fetchlet_vite() -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move { axum::serve(listener, Router::new()).await.unwrap() });
    let error = ViteDev::new(&format!("http://{address}"))?
        .artifact()
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            ViteDevError::Status {
                status: StatusCode::NOT_FOUND,
                ..
            }
        ),
        "{error}"
    );
    Ok(())
}

#[test]
fn accepts_only_http_origins() {
    assert!(ViteDev::new("https://localhost:5173").is_err());
    assert!(ViteDev::new("/relative").is_err());
    assert!(ViteDev::new("http://localhost:5173").is_ok());
    assert_eq!(VITE_BINDING, "FETCHLET_VITE");
}
