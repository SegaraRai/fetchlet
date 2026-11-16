use std::io::{self, BufRead, Write};

use anyhow::{Result, anyhow};
use serde_json::{Value, json};

use fetchlet::{App, Backend, Module};

#[path = "mock_transport.rs"]
mod mock_transport;

async fn serve(mut app: App) -> Result<()> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let reply = match serde_json::from_str::<Value>(&line) {
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
