use serde_json::json;

use fetchlet::{App, Backend, Body, Module, http};

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let source = std::fs::read_to_string("artifacts/functions-hono.js")?;
    let mut app = App::builder(Backend::quickjs())
        .module(Module::new(source))
        .build()?;
    assert_eq!(
        app.call_json("add", &[json!(20), json!(22)]).await?,
        json!(42)
    );
    let request = http::Request::builder()
        .uri("https://fetchlet.invalid/hello/Rust")
        .body(Body::empty())?;
    let response = app.fetch(request).await?;
    let status = response.status();
    let bytes = response.into_body().collect(1024 * 1024).await?;
    println!("{status} {}", std::str::from_utf8(&bytes)?);
    Ok(())
}
