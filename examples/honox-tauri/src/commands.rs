use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use fetchlet_http::Webview;

#[derive(Deserialize, Serialize)]
pub(crate) struct Greeting {
    greeting: String,
    characters: u64,
}

/// Call the `greet` export of the server bundle with a generic function call.
///
/// Commands name the exports they call, so the webview reaches only these
/// functions and never the Fetch handler or other exports.
#[tauri::command]
pub(crate) async fn greet(webview: State<'_, Webview>, name: String) -> Result<Greeting, String> {
    webview
        .app()
        .call("greet", &json!({ "name": name }))
        .await
        .map_err(|error| {
            eprintln!("greet failed: {error:#}");
            "Could not call the function".to_owned()
        })
}
