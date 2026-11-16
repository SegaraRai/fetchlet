use std::io::{self, BufRead, Write};
use std::pin::Pin;
use std::task::{Context, Poll};

use anyhow::{Result, anyhow};
use bytes::Bytes;
use http_body::Frame;
use serde_json::{Value, json};

use fetchlet::{App, Backend, Body, Module, http};

#[path = "mock_transport.rs"]
mod mock_transport;

/// A request body delivered in the given chunks, without a declared length.
struct Chunks(Vec<Bytes>);

impl http_body::Body for Chunks {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let next = (!self.0.is_empty()).then(|| Ok(Frame::data(self.0.remove(0))));
        Poll::Ready(next)
    }
}

/// `{"fetch": {"method", "url", "chunks": [text]}}`: run the Fetch handler with
/// a streamed request body and return the status and body text.
async fn fetch(app: &mut App, input: &Value) -> Result<Value> {
    let chunks = input["chunks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|chunk| Bytes::from(chunk.as_str().unwrap_or_default().to_owned()))
        .collect();
    let request = http::Request::builder()
        .method(input["method"].as_str().unwrap_or("GET"))
        .uri(input["url"].as_str().unwrap_or_default())
        .body(Body::from_http_body(Chunks(chunks)))?;
    let response = app.fetch(request).await?;
    let status = response.status().as_u16();
    let body = response.into_body().collect(1 << 20).await?;
    Ok(json!({ "status": status, "body": String::from_utf8_lossy(&body) }))
}

async fn serve(mut app: App) -> Result<()> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(input) if input.get("fetch").is_some() => {
                match fetch(&mut app, &input["fetch"]).await {
                    Ok(value) => json!({"ok": true, "value": value}),
                    Err(error) => json!({"ok": false, "error": format!("{error:#}")}),
                }
            }
            Ok(input) => {
                let export = input["export"].as_str().unwrap_or("");
                let args = input["args"].as_array().cloned().unwrap_or_default();
                match app.call_json(export, &args).await {
                    Ok(value) => json!({"ok": true, "value": value}),
                    Err(error) => json!({"ok": false, "error": format!("{error:#}")}),
                }
            }
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        };
        println!("FETCHLET_REPLY {reply}");
        io::stdout().flush()?;
    }
    Ok(())
}

async fn execute() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let backend = args
        .get(1)
        .ok_or_else(|| anyhow!("Expected backend and bundle path"))?;
    let source =
        std::fs::read_to_string(args.get(2).ok_or_else(|| anyhow!("Expected bundle path"))?)?;
    let backend = match backend.as_str() {
        #[cfg(feature = "quickjs")]
        "quickjs" => Backend::quickjs(),
        #[cfg(feature = "boa")]
        "boa" => Backend::Boa,
        #[cfg(feature = "v8")]
        "v8" => Backend::v8(),
        _ => return Err(anyhow!("Backend not enabled: {backend}")),
    };

    let mut builder = App::builder(backend).module(Module::new(source));
    if args.get(3).is_some_and(|argument| argument == "--mock") {
        builder = builder.host_services(mock_transport::services()?);
    } else if args.len() > 3 {
        return Err(anyhow!("Unknown argument"));
    }

    serve(builder.build()?).await
}

pub fn run() -> Result<()> {
    std::thread::Builder::new()
        .name("fetchlet-lab".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(execute())
        })?
        .join()
        .map_err(|_| anyhow!("Execution worker panicked"))?
}
