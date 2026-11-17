mod api;
mod cli;
mod config;
#[cfg(feature = "desktop")]
mod desktop;
mod host;
mod serve;
mod workspace;

fn main() -> anyhow::Result<()> {
    cli::run()
}
