use axum::Router;
use tower_http::services::ServeDir;

use super::AxumService;
use crate::Artifact;

/// A router that serves the artifact's client assets and passes every other
/// request to the application.
///
/// Files under the client directory answer GET and HEAD; other methods and
/// missing files reach `rendering`, so the framework handles its own routes,
/// actions and 404 pages. Merge it into a router of Rust routes with
/// [`Router::merge`]; it supplies the fallback.
pub fn artifact_router(artifact: &Artifact, rendering: AxumService) -> Router {
    match artifact.client_directory() {
        Some(client) => Router::new().fallback_service(
            ServeDir::new(client)
                .call_fallback_on_method_not_allowed(true)
                .fallback(rendering),
        ),
        None => Router::new().fallback_service(rendering),
    }
}
