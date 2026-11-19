//! Serving an artifact while it is rebuilt.

use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::Request;
use tower::ServiceExt;

use fetchlet::{App, Backend, Module, WorkerOptions};
use fetchlet_http::{
    Artifact, AxumService, DevReload, DevService, Generation, RELOAD_POLL_PATH, RELOAD_SCRIPT_PATH,
    ReloadError, artifact_router,
};

const POLL: Duration = Duration::from_millis(20);

/// A server module whose page names `version`.
fn server(version: &str) -> String {
    format!(
        r#"
globalThis.fetchletExports = {{
  render(request) {{
    const text = request.url.endsWith("/text") ? "text {version}" : "<p>page {version}</p>";
    const type = request.url.endsWith("/text") ? "text/plain" : "text/html; charset=utf-8";
    return {{
      status: 200,
      headers: [["content-type", type], ["content-length", String(text.length)]],
      body: Array.from(text, (c) => c.charCodeAt(0)),
    }};
  }},
}};
"#
    )
}

const MANIFEST: &str = r#"{"format":"fetchlet-iife","formatVersion":1,"handler":"render","server":"server.js","backend":"quickjs"}"#;

fn directory() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let directory = std::env::temp_dir().join(format!(
        "fetchlet-http-dev-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

/// Write a build as fetchlet/build does: the server module, then the
/// manifest through a rename.
fn write_build(directory: &Path, server: &str) {
    std::fs::write(directory.join("server.js"), server).unwrap();
    let temporary = directory.join("fetchlet.json.tmp");
    std::fs::write(&temporary, MANIFEST).unwrap();
    std::fs::rename(temporary, directory.join("fetchlet.json")).unwrap();
}

async fn generation(artifact: Artifact) -> anyhow::Result<Generation<axum::Router>> {
    let app = App::builder(Backend::quickjs())
        .module(Module::new(artifact.server_source()?))
        .fetch_handler(artifact.handler())
        .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
        .await?;
    let rendering = AxumService::new(app.clone(), "http://localhost")?;
    Ok(Generation::new(artifact_router(&artifact, rendering)).with_app(app))
}

async fn get(service: &DevService<axum::Router>, uri: &str) -> (http::HeaderMap, String) {
    let request = Request::builder()
        .uri(uri)
        .header("accept-encoding", "br")
        .body(Body::empty())
        .unwrap();
    let response = service.clone().oneshot(request).await.unwrap();
    let headers = response.headers().clone();
    let body = to_bytes(Body::new(response.into_body()), 1 << 16)
        .await
        .unwrap();
    (headers, String::from_utf8(body.to_vec()).unwrap())
}

/// The token a page was served with, from its reload script.
fn token(page: &str) -> String {
    let marker = format!("{RELOAD_SCRIPT_PATH}?token=");
    let start = page.find(&marker).unwrap() + marker.len();
    page[start..][..page[start..].find('"').unwrap()].to_owned()
}

async fn eventually(mut condition: impl AsyncFnMut() -> bool) {
    for _ in 0..250 {
        if condition().await {
            return;
        }
        tokio::time::sleep(POLL).await;
    }
    panic!("the condition did not hold within five seconds");
}

#[tokio::test(flavor = "current_thread")]
async fn a_rewritten_manifest_starts_a_new_generation() {
    let directory = directory();
    write_build(&directory, &server("one"));
    let reload = DevReload::watch(&directory)
        .poll_interval(POLL)
        .start(generation)
        .await
        .unwrap();
    let service = reload.service();

    let (headers, page) = get(&service, "/").await;
    assert_eq!(
        page,
        format!(
            "<p>page one</p><script type=\"module\" src=\"{RELOAD_SCRIPT_PATH}?token={}\"></script>",
            token(&page)
        )
    );
    assert!(!headers.contains_key("content-length"));
    let first = token(&page);

    let (_, text) = get(&service, "/text").await;
    assert_eq!(text, "text one", "only HTML gets the script");

    // The manifest is rewritten even when its content is unchanged.
    write_build(&directory, &server("two"));
    eventually(async || get(&service, "/text").await.1 == "text two").await;
    let (_, page) = get(&service, "/").await;
    assert_ne!(token(&page), first);

    let (_, polled) = get(&service, &format!("{RELOAD_POLL_PATH}?token={first}")).await;
    assert_eq!(polled, token(&page));
    reload.shutdown().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn a_poll_waits_for_the_next_generation() {
    let directory = directory();
    write_build(&directory, &server("one"));
    let reload = DevReload::watch(&directory)
        .poll_interval(POLL)
        .start(generation)
        .await
        .unwrap();
    let service = reload.service();
    let current = token(&get(&service, "/").await.1);

    let poll = tokio::spawn({
        let service = service.clone();
        let uri = format!("{RELOAD_POLL_PATH}?token={current}");
        async move { get(&service, &uri).await.1 }
    });
    tokio::time::sleep(POLL * 5).await;
    assert!(
        !poll.is_finished(),
        "the poll waits while the build is unchanged"
    );
    write_build(&directory, &server("two"));
    let next = tokio::time::timeout(Duration::from_secs(5), poll)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(next, current);
    reload.shutdown().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_build_keeps_the_previous_generation() {
    let directory = directory();
    write_build(&directory, &server("one"));
    let errors = Arc::new(AtomicUsize::new(0));
    let reload = DevReload::watch(&directory)
        .poll_interval(POLL)
        .on_error({
            let errors = errors.clone();
            move |error| {
                assert!(matches!(error, ReloadError::Build(_)), "{error}");
                errors.fetch_add(1, Ordering::Relaxed);
            }
        })
        .start(generation)
        .await
        .unwrap();
    let service = reload.service();

    write_build(&directory, "throw new Error('syntax');");
    eventually(async || errors.load(Ordering::Relaxed) == 1).await;
    assert_eq!(get(&service, "/text").await.1, "text one");

    write_build(&directory, &server("three"));
    eventually(async || get(&service, "/text").await.1 == "text three").await;
    reload.shutdown().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn the_first_build_must_start() {
    let directory = directory();
    let error = DevReload::watch(&directory)
        .start(generation)
        .await
        .err()
        .unwrap();
    assert!(matches!(error, ReloadError::Artifact(_)), "{error}");
}

#[tokio::test(flavor = "current_thread")]
async fn the_reload_script_is_served_beside_the_pages() {
    let directory = directory();
    write_build(&directory, &server("one"));
    let reload = DevReload::watch(&directory)
        .start(generation)
        .await
        .unwrap();
    let (headers, script) = get(&reload.service(), &format!("{RELOAD_SCRIPT_PATH}?token=x")).await;
    assert_eq!(headers["content-type"], "text/javascript");
    assert!(script.contains(&format!("`{RELOAD_POLL_PATH}?token=")));
    reload.shutdown().await.unwrap();
}
