use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::http::header::CONTENT_TYPE;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::workspace::{
    Note, NoteSummary, SearchHit, Workspace, WorkspaceError, WorkspaceInfo, WorkspacePath,
};

use super::highlight::Highlighter;

/// Results one search returns at most: a screenful for the search page and
/// the header's suggestions, which bounds the response for any query.
const SEARCH_LIMIT_MAX: usize = 50;
const SEARCH_LIMIT_DEFAULT: usize = 20;

/// State shared by the public HTTP API and the in-process API.
#[derive(Clone)]
pub(crate) struct ApiState {
    pub workspace: Arc<Workspace>,
    pub highlighter: Arc<Highlighter>,
}

type Api = State<ApiState>;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ApiError {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<Conflict>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct Conflict {
    /// The version the note has now; null when it no longer exists.
    pub current_version: Option<String>,
}

impl IntoResponse for WorkspaceError {
    fn into_response(self) -> Response {
        let (status, error, conflict) = match self {
            WorkspaceError::InvalidPath(reason) => {
                (StatusCode::BAD_REQUEST, reason.to_string(), None)
            }
            WorkspaceError::NotANote => (
                StatusCode::BAD_REQUEST,
                "the path is not a Markdown note".into(),
                None,
            ),
            WorkspaceError::NotFound => (
                StatusCode::NOT_FOUND,
                "the note does not exist".into(),
                None,
            ),
            WorkspaceError::Conflict { current } => (
                StatusCode::CONFLICT,
                "the note changed since it was loaded".into(),
                Some(Conflict {
                    current_version: current,
                }),
            ),
            WorkspaceError::TooLarge { limit } => (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("notes are limited to {limit} bytes"),
                None,
            ),
            WorkspaceError::Io(error) => {
                eprintln!("workspace error: {error}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "the workspace could not be accessed".into(),
                    None,
                )
            }
        };
        (status, Json(ApiError { error, conflict })).into_response()
    }
}

fn parse_path(value: &str) -> Result<WorkspacePath, WorkspaceError> {
    Ok(WorkspacePath::parse(value)?)
}

/// The workspace's name, revision and note count.
#[utoipa::path(get, path = "/workspace", tag = "workspace", responses((status = 200, body = WorkspaceInfo)))]
pub(crate) async fn workspace_info(State(api): Api) -> Json<WorkspaceInfo> {
    Json(api.workspace.info())
}

/// Every note of the workspace, ordered by path.
#[utoipa::path(get, path = "/notes", tag = "notes", responses((status = 200, body = Vec<NoteSummary>)))]
pub(crate) async fn list_notes(State(api): Api) -> Json<Vec<NoteSummary>> {
    Json(api.workspace.list())
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct NoteQuery {
    /// Workspace path of the note, such as `guide/start.md`.
    path: String,
}

/// One note with its content and version.
#[utoipa::path(
    get,
    path = "/note",
    tag = "notes",
    params(NoteQuery),
    responses(
        (status = 200, body = Note),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
    )
)]
pub(crate) async fn get_note(
    State(api): Api,
    Query(query): Query<NoteQuery>,
) -> Result<Json<Note>, WorkspaceError> {
    Ok(Json(api.workspace.read(&parse_path(&query.path)?)?))
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveNote {
    path: String,
    content: String,
    /// The version the edit started from; null creates a note that must not exist.
    base_version: Option<String>,
}

/// Creates or updates a note. A stale `base_version` is a conflict.
#[utoipa::path(
    put,
    path = "/note",
    tag = "notes",
    request_body = SaveNote,
    responses(
        (status = 200, body = Note),
        (status = 400, body = ApiError),
        (status = 409, body = ApiError),
        (status = 413, body = ApiError),
    )
)]
pub(crate) async fn save_note(
    State(api): Api,
    Json(input): Json<SaveNote>,
) -> Result<Json<Note>, WorkspaceError> {
    let path = parse_path(&input.path)?;
    Ok(Json(api.workspace.save(
        &path,
        &input.content,
        input.base_version.as_deref(),
    )?))
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct DeleteQuery {
    path: String,
    /// The version the caller last saw.
    version: String,
}

/// Deletes a note if it still has the given version.
#[utoipa::path(
    delete,
    path = "/note",
    tag = "notes",
    params(DeleteQuery),
    responses(
        (status = 204),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    )
)]
pub(crate) async fn delete_note(
    State(api): Api,
    Query(query): Query<DeleteQuery>,
) -> Result<StatusCode, WorkspaceError> {
    api.workspace
        .delete(&parse_path(&query.path)?, &query.version)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct SearchQuery {
    /// Terms separated by spaces; every term must match.
    q: String,
    /// At most 50; 20 by default.
    limit: Option<usize>,
}

/// Case-insensitive full-text search over titles and bodies.
#[utoipa::path(get, path = "/search", tag = "notes", params(SearchQuery), responses((status = 200, body = Vec<SearchHit>)))]
pub(crate) async fn search(
    State(api): Api,
    Query(query): Query<SearchQuery>,
) -> Json<Vec<SearchHit>> {
    let limit = query
        .limit
        .unwrap_or(SEARCH_LIMIT_DEFAULT)
        .min(SEARCH_LIMIT_MAX);
    Json(api.workspace.search(&query.q, limit))
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct CodeBlock {
    code: String,
    /// The fence's info string, such as `rust` or `ts`.
    language: String,
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct HighlightRequest {
    blocks: Vec<CodeBlock>,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct HighlightResponse {
    /// HTML for each block in order, or null when the language is unknown.
    blocks: Vec<Option<String>>,
}

/// Highlights the code blocks of one note in a single call.
#[utoipa::path(post, path = "/highlight", tag = "rendering", request_body = HighlightRequest, responses((status = 200, body = HighlightResponse)))]
pub(crate) async fn highlight(
    State(api): Api,
    Json(input): Json<HighlightRequest>,
) -> Json<HighlightResponse> {
    let blocks = input
        .blocks
        .iter()
        .map(|block| api.highlighter.highlight(&block.code, &block.language))
        .collect();
    Json(HighlightResponse { blocks })
}

/// Colors for highlighted code, light and dark.
#[utoipa::path(get, path = "/highlight.css", tag = "rendering", responses((status = 200, content_type = "text/css", body = String)))]
pub(crate) async fn highlight_stylesheet(State(api): Api) -> Response {
    (
        [(CONTENT_TYPE, "text/css; charset=utf-8")],
        api.highlighter.stylesheet().to_owned(),
    )
        .into_response()
}
