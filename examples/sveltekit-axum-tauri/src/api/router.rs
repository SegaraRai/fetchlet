use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::workspace::Change;

use super::events::workspace_events;
use super::routes::{self, ApiState};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "mdw",
        description = "The Markdown workspace API. The SvelteKit server calls it in-process; `mdw serve` also publishes it under /api/v1.",
        version = "0.1.0"
    ),
    components(schemas(Change))
)]
struct ApiDoc;

fn documented() -> (Router<ApiState>, utoipa::openapi::OpenApi) {
    let mut document = ApiDoc::openapi();
    // utoipa fills the license from Cargo metadata, which this example leaves empty.
    document.info.license = None;
    OpenApiRouter::with_openapi(document)
        .routes(routes!(routes::workspace_info))
        .routes(routes!(routes::list_notes))
        .routes(routes!(
            routes::get_note,
            routes::save_note,
            routes::delete_note
        ))
        .routes(routes!(routes::search))
        .routes(routes!(routes::highlight))
        .routes(routes!(routes::highlight_stylesheet))
        .split_for_parts()
}

/// The OpenAPI document from which the TypeScript client types are generated.
pub(crate) fn openapi_document() -> String {
    documented()
        .1
        .to_pretty_json()
        .expect("the OpenAPI document serializes")
}

/// The API that server-side JavaScript reaches in-process. Its request body
/// budget admits a note's content with JSON escaping, which stays within
/// twice the size for ordinary text.
pub(crate) fn api_router(state: ApiState, note_bytes: usize) -> Router {
    documented()
        .0
        .layer(DefaultBodyLimit::max(note_bytes.saturating_mul(2)))
        .with_state(state)
}

/// The same API for browsers, with the change stream added. The stream never
/// completes, so it is left out of the in-process API, whose responses are
/// collected whole.
pub(crate) fn public_api_router(state: ApiState, note_bytes: usize) -> Router {
    api_router(state.clone(), note_bytes).merge(
        Router::new()
            .route("/events", get(workspace_events))
            .with_state(state),
    )
}

#[cfg(test)]
mod tests {
    use super::openapi_document;

    /// The checked-in document is what the TypeScript types are generated
    /// from; regenerate both with `vp run generate:api` after changing the API.
    /// The documents are compared as JSON values, so formatting is free.
    #[test]
    fn checked_in_openapi_document_is_current() {
        let checked_in: serde_json::Value =
            serde_json::from_str(include_str!("../../openapi.json")).unwrap();
        let current: serde_json::Value = serde_json::from_str(&openapi_document()).unwrap();
        assert_eq!(checked_in, current);
    }
}
