use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::http::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
};
use axum::response::{IntoResponse, Response};

use crate::workspace::{WorkspaceError, WorkspacePath};

use super::routes::ApiState;

/// State of the file route: the API state and the size budget for one file.
#[derive(Clone)]
pub(crate) struct FileState {
    pub api: ApiState,
    pub file_bytes: usize,
}

/// Serves a workspace file, such as an image a note embeds, at `/files/<path>`.
///
/// The files are the user's own, but a note can link any of them, so each
/// response is sandboxed: an SVG or HTML file opened from here runs no script
/// and the browser does not sniff another type.
pub(crate) async fn workspace_file(
    State(state): State<FileState>,
    Path(path): Path<String>,
) -> Response {
    let path = match WorkspacePath::parse(&path) {
        Ok(path) => path,
        Err(error) => return WorkspaceError::from(error).into_response(),
    };
    let bytes = match state.api.workspace.read_file(&path, state.file_bytes) {
        Ok(bytes) => bytes,
        Err(error) => return error.into_response(),
    };
    (
        StatusCode::OK,
        [
            (CONTENT_TYPE, content_type(path.extension())),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
            ),
            (CACHE_CONTROL, "no-cache"),
        ],
        bytes,
    )
        .into_response()
}

fn content_type(extension: Option<&str>) -> &'static str {
    match extension.map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("jxl") => "image/jxl",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("md" | "txt" | "csv" | "log") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}
