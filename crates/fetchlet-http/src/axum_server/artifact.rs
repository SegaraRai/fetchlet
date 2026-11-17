use axum::Router;
use tower_http::services::ServeDir;

use super::AxumService;
use crate::{Artifact, AssetService};

/// A router that serves the artifact's client assets and passes every other
/// request to the application.
///
/// Assets answer GET and HEAD, from the artifact's asset archive when it has
/// one and from the client directory otherwise; other methods and missing
/// paths reach `rendering`, so the framework handles its own routes, actions
/// and 404 pages. Merge it into a router of Rust routes with
/// [`Router::merge`]; it supplies the fallback.
pub fn artifact_router(artifact: &Artifact, rendering: AxumService) -> Router {
    if let Some(archive) = artifact.asset_archive() {
        return Router::new().fallback_service(AssetService::new(archive.clone(), rendering));
    }
    match artifact.client_directory() {
        Some(client) => Router::new().fallback_service(
            ServeDir::new(client)
                .call_fallback_on_method_not_allowed(true)
                .fallback(rendering),
        ),
        None => Router::new().fallback_service(rendering),
    }
}
