mod config;
mod server;
mod services;

use std::path::PathBuf;

use config::Config;

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let config_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config.json"));
    server::run(Config::load(&config_path)?).await
}
