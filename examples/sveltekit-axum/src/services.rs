use std::future::pending;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use fetchlet::{Context, HostServices, OriginRouter, Result};
use fetchlet_axum::router_transport;

/// The origin that names the in-process Rust API for server-side JavaScript.
pub(crate) const RUST_ORIGIN: &str = "https://rust.fetchlet.test";

/// Byte budget for a project request body, owned by this API: names are short.
const PROJECT_BODY_BYTES: usize = 4096;

/// The caller of an SSR request, derived by Rust from its connection.
#[derive(Clone)]
pub(crate) struct Caller {
    pub(crate) address: String,
}

#[derive(Clone, Serialize)]
struct Project {
    id: usize,
    name: String,
}

#[derive(Deserialize)]
struct NewProject {
    name: String,
}

/// Rust application state shared by public HTTP and in-process fetches.
#[derive(Default)]
pub(crate) struct ProjectsApi {
    projects: Mutex<Vec<Project>>,
    calls: AtomicUsize,
    cancelled: AtomicUsize,
}

type Api = State<Arc<ProjectsApi>>;

/// The API as one axum router. The server mounts it for browsers, and the
/// in-process route serves it to server-side JavaScript without a socket.
/// HTTP errors are its responses; JavaScript sees them as Responses.
pub(crate) fn api_router(api: Arc<ProjectsApi>) -> Router {
    Router::new()
        .route("/greeting", get(greeting))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{id}", get(project))
        .route("/caller", get(caller))
        .route("/slow", get(slow))
        .route("/failure", get(failure))
        .layer(DefaultBodyLimit::max(PROJECT_BODY_BYTES))
        .layer(middleware::from_fn_with_state(api.clone(), count_calls))
        // Reading the counters does not change them.
        .route("/stats", get(stats))
        .with_state(api)
}

/// Route the API origin to the router in-process. The policy admits only that
/// origin, for `platform.env.RUST.fetch` and for the global `fetch` that
/// SvelteKit's `event.fetch` uses for other origins.
pub(crate) fn host_services(message: &str, api: Arc<ProjectsApi>) -> Result<HostServices> {
    let service = OriginRouter::new()
        .internal(RUST_ORIGIN, router_transport(api_router(api)))?
        .into_service();

    HostServices::new()
        .env("MESSAGE", message)?
        .outbound(service.clone())
        .service("RUST", service)
}

async fn count_calls(State(api): Api, request: Request, next: Next) -> Response {
    api.calls.fetch_add(1, Ordering::SeqCst);
    next.run(request).await
}

async fn greeting() -> Json<Value> {
    Json(json!({ "message": "Rustサービスからの挨拶です。" }))
}

async fn list_projects(State(api): Api) -> Json<Vec<Project>> {
    Json(api.projects.lock().unwrap().clone())
}

async fn create_project(State(api): Api, Json(input): Json<NewProject>) -> Response {
    let name = input.name.trim().to_owned();
    if name.is_empty() {
        return error(StatusCode::BAD_REQUEST, "name is required");
    }
    let mut projects = api.projects.lock().unwrap();
    let project = Project {
        id: projects.len() + 1,
        name,
    };
    projects.push(project.clone());
    (StatusCode::CREATED, Json(project)).into_response()
}

async fn project(State(api): Api, Path(id): Path<usize>) -> Response {
    let projects = api.projects.lock().unwrap();
    match projects.iter().find(|project| project.id == id) {
        Some(project) => Json(project.clone()).into_response(),
        None => error(StatusCode::NOT_FOUND, "project not found"),
    }
}

/// The trusted caller. Only SSR requests carry it, through the Context; no
/// header that JavaScript or a browser sends can supply it.
async fn caller(context: Option<Extension<Context>>) -> Response {
    match context
        .as_ref()
        .and_then(|Extension(context)| context.get::<Caller>())
    {
        Some(caller) => Json(json!({ "address": caller.address })).into_response(),
        None => error(StatusCode::UNAUTHORIZED, "no trusted caller"),
    }
}

/// Runs until the JavaScript side aborts; dropping the handler records it.
async fn slow(State(api): Api) -> StatusCode {
    let _guard = CancelGuard(api);
    pending::<StatusCode>().await
}

async fn failure() -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

async fn stats(State(api): Api) -> Json<Value> {
    Json(json!({
        "calls": api.calls.load(Ordering::SeqCst),
        "cancelled": api.cancelled.load(Ordering::SeqCst),
    }))
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// Counts a request that ended before its handler finished.
struct CancelGuard(Arc<ProjectsApi>);

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.0.cancelled.fetch_add(1, Ordering::SeqCst);
    }
}
