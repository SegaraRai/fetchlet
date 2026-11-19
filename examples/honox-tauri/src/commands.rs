use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use std::sync::Arc;

use crate::frontend::Frontend;

/// The frontend shared by the URI scheme protocol and commands.
pub(crate) struct Functions(pub Arc<Frontend>);

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
pub(crate) async fn greet(
    functions: State<'_, Functions>,
    name: String,
) -> Result<Greeting, String> {
    functions
        .0
        .current()
        .app
        .call("greet", &json!({ "name": name }))
        .await
        .map_err(|error| {
            eprintln!("greet failed: {error:#}");
            "Could not call the function".to_owned()
        })
}
