use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

use super::routes::ApiState;

/// Interval of comments that keep an idle event stream open through proxies.
const KEEP_ALIVE: Duration = Duration::from_secs(15);

/// Workspace changes as server-sent events, for browsers of `mdw serve`.
/// The desktop window receives the same changes as Tauri events instead,
/// because its URI scheme protocol answers with complete bodies.
pub(crate) async fn workspace_events(
    State(api): State<ApiState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let changes = BroadcastStream::new(api.workspace.subscribe()).filter_map(|change| {
        // A lagging subscriber skips to the next change; any change makes
        // the page refresh everything it shows.
        let change = change.ok()?;
        Event::default()
            .event("change")
            .json_data(change)
            .ok()
            .map(Ok)
    });
    Sse::new(changes).keep_alive(KeepAlive::new().interval(KEEP_ALIVE))
}
