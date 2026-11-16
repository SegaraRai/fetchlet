use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use fetchlet::{
    Body, Error, FetchPolicy, FetchService, HostServices, Request, Response, Result, http,
    transport_fn,
};

/// The origin that names the in-process Rust API for server-side JavaScript.
pub(crate) const RUST_ORIGIN: &str = "https://rust.fetchlet.test";

/// Byte budget for a project request body, owned by this API: names are short.
const PROJECT_BODY_BYTES: usize = 4096;

#[derive(Clone, Serialize)]
struct Project {
    id: usize,
    name: String,
}

#[derive(Deserialize)]
struct NewProject {
    name: String,
}

/// Rust application state that the in-process API shares with the server.
#[derive(Default)]
pub(crate) struct ProjectsApi {
    projects: Mutex<Vec<Project>>,
    calls: AtomicUsize,
    cancelled: AtomicUsize,
}

/// Counts a request that ended before its handler finished.
struct CancelGuard<'a>(&'a AtomicUsize);

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl ProjectsApi {
    /// Handle one in-process request. HTTP errors are responses; an `Err`
    /// rejects the JavaScript fetch with a general message.
    async fn handle(&self, request: Request) -> Result<Response> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let method = request.method().clone();
        let path = request.uri().path().to_owned();
        match (method.as_str(), path.as_str()) {
            ("GET", "/greeting") => Ok(json_response(
                200,
                &json!({ "message": "Rustサービスからの挨拶です。" }),
            )),
            ("GET", "/projects") => {
                let projects = self.projects.lock().unwrap().clone();
                Ok(json_response(200, &json!(projects)))
            }
            ("POST", "/projects") => {
                let body = request.into_body().collect(PROJECT_BODY_BYTES).await?;
                let Ok(NewProject { name }) = serde_json::from_slice(&body) else {
                    return Ok(json_response(400, &json!({ "error": "invalid project" })));
                };
                let name = name.trim().to_owned();
                if name.is_empty() {
                    return Ok(json_response(400, &json!({ "error": "name is required" })));
                }
                let mut projects = self.projects.lock().unwrap();
                let project = Project {
                    id: projects.len() + 1,
                    name,
                };
                projects.push(project.clone());
                Ok(json_response(201, &json!(project)))
            }
            ("GET", path) if path.starts_with("/projects/") => {
                let project = path["/projects/".len()..]
                    .parse::<usize>()
                    .ok()
                    .and_then(|id| {
                        let projects = self.projects.lock().unwrap();
                        projects.iter().find(|project| project.id == id).cloned()
                    });
                Ok(match project {
                    Some(project) => json_response(200, &json!(project)),
                    None => json_response(404, &json!({ "error": "project not found" })),
                })
            }
            ("GET", "/slow") => {
                // Runs until the JavaScript side aborts; the invocation then
                // drops this future, which the guard records.
                let _guard = CancelGuard(&self.cancelled);
                std::future::pending::<()>().await;
                unreachable!()
            }
            ("GET", "/stats") => Ok(json_response(200, &self.stats())),
            ("GET", "/failure") => Err(Error::Transport("database detail stays in Rust".into())),
            _ => Ok(json_response(404, &json!({ "error": "no such route" }))),
        }
    }

    /// Calls and cancellations observed so far.
    pub(crate) fn stats(&self) -> Value {
        json!({
            "calls": self.calls.load(Ordering::SeqCst),
            "cancelled": self.cancelled.load(Ordering::SeqCst),
        })
    }
}

fn json_response(status: u16, value: &Value) -> Response {
    let mut response = Response::new(Body::from(value.to_string()));
    *response.status_mut() = http::StatusCode::from_u16(status).expect("valid status");
    response.headers_mut().insert(
        "content-type",
        http::HeaderValue::from_static("application/json"),
    );
    response
}

/// The in-process API serves both `platform.env.RUST.fetch` and the global
/// `fetch` (which SvelteKit's `event.fetch` uses for other origins). The policy
/// admits only its origin, so every other destination is denied.
pub(crate) fn host_services(message: &str, api: Arc<ProjectsApi>) -> Result<HostServices> {
    let policy = FetchPolicy::deny_all().allow_origin(RUST_ORIGIN)?;
    let service = FetchService::new(
        transport_fn(move |request| {
            let api = api.clone();
            async move { api.handle(request).await }
        }),
        policy,
    );

    HostServices::new()
        .env("MESSAGE", message)?
        .outbound(service.clone())
        .service("RUST", service)
}
