use std::path::Path;

use anyhow::Result;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use tauri::http::header::{CONTENT_TYPE, HeaderValue};
use tauri::http::{Request, Response, StatusCode};
use tower::ServiceExt;
use tower_http::services::ServeDir;

use fetchlet::AppHandle;
use fetchlet_tower::FetchletService;

/// The URI scheme the webview loads pages from.
pub(crate) const SCHEME: &str = "fetchlet";

/// The origin the application sees. WebView2 and Android serve custom schemes
/// as `http://<scheme>.localhost`; the other platforms use `<scheme>://localhost`.
/// Handlers see this origin on every platform, so absolute URLs stay the same.
pub(crate) const PUBLIC_ORIGIN: &str = "http://fetchlet.localhost";

/// The URL the main window opens on this platform.
pub(crate) fn start_url() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://fetchlet.localhost/"
    } else {
        "fetchlet://localhost/"
    }
}

/// Answers webview requests in-process: Rust routes, then files of the client
/// build, then the fetchlet application.
#[derive(Clone)]
pub(crate) struct Protocol {
    assets: ServeDir<FetchletService>,
    response_body_bytes: usize,
}

impl Protocol {
    pub fn new(
        app: AppHandle,
        client_directory: &Path,
        response_body_bytes: usize,
    ) -> Result<Self> {
        // The webview buffers request bodies, so the service collects them
        // within the application's request body budget before the handler runs.
        let rendering = FetchletService::new(app, PUBLIC_ORIGIN)?
            .on_error(|error| eprintln!("request failed: {error:#}"));
        let assets = ServeDir::new(client_directory)
            .call_fallback_on_method_not_allowed(true)
            .fallback(rendering);
        Ok(Self {
            assets,
            response_body_bytes,
        })
    }

    pub async fn respond(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        if request.uri().path() == "/api/rust" {
            return json_response(r#"{"message":"served by the Tauri protocol"}"#);
        }
        let request = request.map(|body| Full::new(Bytes::from(body)));
        let response: Response<_> = match self.assets.clone().oneshot(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        };
        let (parts, body) = response.into_parts();
        match Limited::new(body, self.response_body_bytes).collect().await {
            Ok(collected) => Response::from_parts(parts, collected.to_bytes().to_vec()),
            Err(error) => {
                eprintln!("response failed: {error}");
                text_response(StatusCode::BAD_GATEWAY, "Bad Gateway")
            }
        }
    }
}

fn json_response(body: &'static str) -> Response<Vec<u8>> {
    let mut response = Response::new(body.as_bytes().to_vec());
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn text_response(status: StatusCode, body: &'static str) -> Response<Vec<u8>> {
    let mut response = Response::new(body.as_bytes().to_vec());
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;
    use std::path::PathBuf;

    use fetchlet::{App, Backend, Limits, Module, WorkerOptions};
    use tauri::http::{Method, Request, StatusCode};

    use super::Protocol;

    // A bare Fetch handler that answers with the URL it received, or with
    // a body of `size` bytes for `/large?size`.
    const HANDLER: &str = r#"
        const ascii = (text) => Array.from(text, (character) => character.charCodeAt(0));
        globalThis.fetchletExports = {
          handle(request) {
            const size = /\/large\?(\d+)$/.exec(request.url);
            const body = size ? new Array(Number(size[1])).fill(97) : ascii("rendered " + request.url);
            return { status: 200, headers: [["content-type", "text/plain"]], body };
          },
        };
    "#;

    const REQUEST_BODY_BYTES: usize = 16;

    const RESPONSE_BODY_BYTES: usize = 64;

    struct Fixture {
        protocol: Protocol,
        app: fetchlet::AppHandle,
        directory: PathBuf,
    }

    impl Fixture {
        async fn new(name: &str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "fetchlet-honox-tauri-{name}-{}",
                std::process::id()
            ));
            let client = directory.join("client");
            std::fs::create_dir_all(client.join("static")).unwrap();
            std::fs::write(client.join("static/app.js"), "export {};").unwrap();
            std::fs::write(directory.join("server.js"), "private").unwrap();
            let app = App::builder(Backend::quickjs())
                .module(Module::new(HANDLER))
                .limits(Limits {
                    request_body_bytes: Some(REQUEST_BODY_BYTES),
                    ..Limits::default()
                })
                .spawn(WorkerOptions::new(NonZeroUsize::new(2).unwrap()))
                .await
                .unwrap();
            let protocol = Protocol::new(app.clone(), &client, RESPONSE_BODY_BYTES).unwrap();
            Self {
                protocol,
                app,
                directory,
            }
        }

        async fn send(&self, method: Method, path: &str, body: &[u8]) -> (StatusCode, String) {
            let request = Request::builder()
                .method(method)
                .uri(format!("http://fetchlet.localhost{path}"))
                .body(body.to_vec())
                .unwrap();
            let response = self.protocol.respond(request).await;
            let status = response.status();
            (status, String::from_utf8(response.into_body()).unwrap())
        }

        async fn get(&self, path: &str) -> (StatusCode, String) {
            self.send(Method::GET, path, b"").await
        }

        async fn finish(self) {
            self.app.shutdown().await.unwrap();
            std::fs::remove_dir_all(self.directory).unwrap();
        }
    }

    #[tokio::test]
    async fn serves_client_files_and_renders_the_rest_at_the_public_origin() {
        let fixture = Fixture::new("routes").await;
        let (status, body) = fixture.get("/static/app.js").await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "export {};"));
        let (status, body) = fixture.get("/page?name=Rust").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "rendered http://fetchlet.localhost/page?name=Rust");
        let (_, body) = fixture.get("/api/rust").await;
        assert_eq!(body, r#"{"message":"served by the Tauri protocol"}"#);
        fixture.finish().await;
    }

    #[tokio::test]
    async fn keeps_files_outside_the_client_directory_private() {
        let fixture = Fixture::new("private").await;
        for path in [
            "/../server.js",
            "/%2e%2e/server.js",
            "/static/..%2f..%2fserver.js",
        ] {
            let (_, body) = fixture.get(path).await;
            assert_ne!(body, "private", "{path}");
            assert!(body.starts_with("rendered "), "{path}: {body}");
        }
        fixture.finish().await;
    }

    #[tokio::test]
    async fn applies_the_request_and_response_body_budgets() {
        let fixture = Fixture::new("budgets").await;
        let oversized = [b'x'; REQUEST_BODY_BYTES + 1];
        let (status, _) = fixture.send(Method::POST, "/echo", &oversized).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        let (status, body) = fixture.get(&format!("/large?{RESPONSE_BODY_BYTES}")).await;
        assert_eq!((status, body.len()), (StatusCode::OK, RESPONSE_BODY_BYTES));
        let (status, _) = fixture
            .get(&format!("/large?{}", RESPONSE_BODY_BYTES + 1))
            .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        // The application keeps serving after both refusals.
        assert_eq!(fixture.get("/").await.0, StatusCode::OK);
        fixture.finish().await;
    }
}
