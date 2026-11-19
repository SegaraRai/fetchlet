//! `Server`: one artifact behind Rust routes, over a real socket.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::routing::get;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use fetchlet::HostServices;
use fetchlet_http::{Server, ServerError};

/// A server module whose page shows the URL it was asked for.
const SERVER: &str = r#"
globalThis.fetchletExports = {
  render(request) {
    const text = "<p>" + request.url + "</p>";
    return {
      status: 200,
      headers: [["content-type", "text/html; charset=utf-8"], ["content-length", String(text.length)]],
      body: Array.from(text, (c) => c.charCodeAt(0)),
    };
  },
};
"#;

fn manifest(backend: &str) -> String {
    format!(
        r#"{{"format":"fetchlet-iife","formatVersion":1,"handler":"render","server":"server.js","client":"client","backend":"{backend}"}}"#
    )
}

fn directory() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let directory = std::env::temp_dir().join(format!(
        "fetchlet-http-server-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(directory.join("client")).unwrap();
    directory
}

fn write_build(directory: &Path, backend: &str) {
    std::fs::write(directory.join("server.js"), SERVER).unwrap();
    std::fs::write(directory.join("client/app.txt"), "client file").unwrap();
    std::fs::write(directory.join("fetchlet.json"), manifest(backend)).unwrap();
}

/// The status and body of a GET over a new connection.
async fn get_text(address: std::net::SocketAddr, path: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    let status = response[9..12].parse().unwrap();
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    (status, body)
}

#[tokio::test(flavor = "current_thread")]
async fn routes_assets_and_the_application_share_one_listener() {
    let build = directory();
    write_build(&build, "quickjs");
    let made = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let server = Server::new(&build)
        .host_services({
            let made = made.clone();
            move || {
                made.fetch_add(1, Ordering::Relaxed);
                Ok(HostServices::new())
            }
        })
        .routes(|_| Router::new().route("/api/rust", get(|| async { "from Rust" })))
        .public_origin("https://app.example");
    let serving = tokio::spawn(server.serve_with_shutdown(listener, async {
        let _ = stopped.await;
    }));

    assert_eq!(
        get_text(address, "/api/rust").await,
        (200, "from Rust".into())
    );
    assert_eq!(
        get_text(address, "/app.txt").await,
        (200, "client file".into())
    );
    let (status, page) = get_text(address, "/page?x=1").await;
    assert_eq!(status, 200);
    assert!(
        page.contains("<p>https://app.example/page?x=1</p>"),
        "{page}"
    );
    assert_eq!(made.load(Ordering::Relaxed), 1);

    stop.send(()).unwrap();
    serving.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(build);
}

#[tokio::test(flavor = "current_thread")]
async fn the_artifact_selects_the_engine() {
    let build = directory();
    write_build(&build, "spidermonkey");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let error = Server::new(&build)
        .serve_with_shutdown(listener, async {})
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("unknown artifact backend"),
        "{error}"
    );
    let _ = std::fs::remove_dir_all(build);
}

#[tokio::test(flavor = "current_thread")]
async fn a_missing_build_says_to_build_first() {
    let build = directory().join("missing");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let error = Server::new(&build)
        .serve_with_shutdown(listener, async {})
        .await
        .unwrap_err();
    assert!(matches!(error, ServerError::Artifact { .. }), "{error}");
    assert!(error.to_string().contains("build the frontend"), "{error}");
}

/// With `dev`, each build written to the directory replaces the application,
/// with host services made for it.
#[cfg(feature = "dev")]
#[tokio::test(flavor = "current_thread")]
async fn under_dev_each_new_build_serves() {
    use std::time::{Duration, Instant};

    let build = directory();
    write_build(&build, "quickjs");
    let made = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let server = Server::new(&build).host_services({
        let made = made.clone();
        move || {
            made.fetch_add(1, Ordering::Relaxed);
            Ok(HostServices::new())
        }
    });
    let serving = tokio::spawn(server.serve_with_shutdown(listener, async {
        let _ = stopped.await;
    }));
    let (_, first) = get_text(address, "/").await;
    assert!(first.contains("<p>http://"), "{first}");

    // A coarse file system clock must see a new modification time.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    std::fs::write(
        build.join("server.js"),
        SERVER.replace("\"<p>\"", "\"<p>v2 \""),
    )
    .unwrap();
    let temporary = build.join("fetchlet.json.tmp");
    std::fs::write(&temporary, manifest("quickjs")).unwrap();
    std::fs::rename(temporary, build.join("fetchlet.json")).unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (_, page) = get_text(address, "/").await;
        if page.contains("<p>v2 http://") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the new build never served: {page}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(made.load(Ordering::Relaxed), 2);

    stop.send(()).unwrap();
    serving.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(build);
}
