//! `Server::webview` and `WebviewResponder`: a custom URI scheme's requests
//! answered in-process with whole bodies.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::routing::get;
use http::{Method, Request, StatusCode};

use fetchlet::Limits;
use fetchlet_http::{Server, Webview, WebviewResponder, WebviewScheme};

const SCHEME: WebviewScheme = WebviewScheme::new("app");

/// Answers with the URL it received, or with a body of `size` bytes for
/// `/large?size`.
const SERVER: &str = r#"
const ascii = (text) => Array.from(text, (character) => character.charCodeAt(0));
globalThis.fetchletExports = {
  render(request) {
    const size = /\/large\?(\d+)$/.exec(request.url);
    const body = size ? new Array(Number(size[1])).fill(97) : ascii("rendered " + request.url);
    return {
      status: 200,
      headers: [["content-type", "text/plain"]],
      body,
    };
  },
  greet(name) {
    return "Hello, " + name;
  },
};
"#;

const MANIFEST: &str = r#"{"format":"fetchlet-iife","formatVersion":1,"handler":"render","server":"server.js","client":"client","backend":"quickjs"}"#;

const REQUEST_BODY_BYTES: usize = 16;

const RESPONSE_BODY_BYTES: usize = 64;

fn build() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let directory = std::env::temp_dir().join(format!(
        "fetchlet-http-webview-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(directory.join("client/static")).unwrap();
    std::fs::write(directory.join("client/static/app.js"), "export {};").unwrap();
    std::fs::write(directory.join("server.js"), SERVER).unwrap();
    std::fs::write(directory.join("fetchlet.json"), MANIFEST).unwrap();
    directory
}

fn request(method: Method, path: &str, body: &[u8]) -> Request<Vec<u8>> {
    Request::builder()
        .method(method)
        .uri(format!(
            "{}{}",
            SCHEME.start_url().trim_end_matches('/'),
            path
        ))
        .body(body.to_vec())
        .unwrap()
}

fn text(response: http::Response<Vec<u8>>) -> (StatusCode, String) {
    let status = response.status();
    (status, String::from_utf8(response.into_body()).unwrap())
}

async fn get_text(webview: &Webview, path: &str) -> (StatusCode, String) {
    text(webview.respond(request(Method::GET, path, b"")).await)
}

async fn start(directory: &Path) -> Webview {
    Server::new(directory)
        .routes(|_| Router::new().route("/api/rust", get(|| async { "from Rust" })))
        .limits(Limits {
            request_body_bytes: Some(REQUEST_BODY_BYTES),
            ..Limits::default()
        })
        .webview(SCHEME, RESPONSE_BODY_BYTES)
        .await
        .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn routes_assets_and_the_application_answer_at_the_scheme_origin() {
    let directory = build();
    let webview = start(&directory).await;
    assert_eq!(
        get_text(&webview, "/api/rust").await,
        (StatusCode::OK, "from Rust".into())
    );
    assert_eq!(
        get_text(&webview, "/static/app.js").await,
        (StatusCode::OK, "export {};".into())
    );
    assert_eq!(
        get_text(&webview, "/page?name=Rust").await,
        (
            StatusCode::OK,
            "rendered http://app.localhost/page?name=Rust".into()
        )
    );
    let greeting = webview
        .app()
        .call_json("greet", &["Rust".into()])
        .await
        .unwrap();
    assert_eq!(greeting, "Hello, Rust");
    webview.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test(flavor = "current_thread")]
async fn files_outside_the_client_directory_stay_private() {
    let directory = build();
    let webview = start(&directory).await;
    for path in [
        "/../server.js",
        "/%2e%2e/server.js",
        "/static/..%2f..%2fserver.js",
    ] {
        let (_, body) = get_text(&webview, path).await;
        assert!(body.starts_with("rendered "), "{path}: {body}");
    }
    webview.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test(flavor = "current_thread")]
async fn the_request_and_response_body_budgets_apply() {
    let directory = build();
    let webview = start(&directory).await;
    let oversized = [b'x'; REQUEST_BODY_BYTES + 1];
    let (status, _) = text(
        webview
            .respond(request(Method::POST, "/echo", &oversized))
            .await,
    );
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    let (status, body) = get_text(&webview, &format!("/large?{RESPONSE_BODY_BYTES}")).await;
    assert_eq!((status, body.len()), (StatusCode::OK, RESPONSE_BODY_BYTES));
    let (status, _) = get_text(&webview, &format!("/large?{}", RESPONSE_BODY_BYTES + 1)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    // The application keeps serving after both refusals.
    assert_eq!(get_text(&webview, "/").await.0, StatusCode::OK);
    webview.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(directory);
}

/// The responder takes any service and makes one for each request.
#[tokio::test(flavor = "current_thread")]
async fn the_responder_makes_a_service_for_each_request() {
    let made = AtomicUsize::new(0);
    let responder = WebviewResponder::new(
        || {
            let generation = made.fetch_add(1, Ordering::Relaxed);
            Router::new().route(
                "/",
                get(move || async move { format!("generation {generation}") }),
            )
        },
        RESPONSE_BODY_BYTES,
    );
    for expected in ["generation 0", "generation 1"] {
        let (status, body) = text(responder.respond(request(Method::GET, "/", b"")).await);
        assert_eq!((status, body.as_str()), (StatusCode::OK, expected));
    }
}

/// With `dev`, each new build answers the next request and is announced.
#[cfg(feature = "dev")]
#[tokio::test(flavor = "current_thread")]
async fn under_dev_a_new_build_answers_and_is_announced() {
    use std::time::Duration;

    let directory = build();
    let webview = start(&directory).await;
    let mut reloads = webview.reloads();
    // A coarse file system clock must see a new modification time.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    std::fs::write(
        directory.join("server.js"),
        SERVER.replace("\"rendered \"", "\"v2 \""),
    )
    .unwrap();
    let temporary = directory.join("fetchlet.json.tmp");
    std::fs::write(&temporary, MANIFEST).unwrap();
    std::fs::rename(temporary, directory.join("fetchlet.json")).unwrap();
    tokio::time::timeout(Duration::from_secs(10), reloads.next())
        .await
        .expect("the new build was never announced")
        .unwrap();
    assert_eq!(get_text(&webview, "/").await.1, "v2 http://app.localhost/");
    webview.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(directory);
}
