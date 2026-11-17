use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use crate::api::openapi_document;
use crate::config::Config;
use crate::serve::{self, ServeOptions};

/// A Markdown workspace: browse, search and edit a folder of notes.
#[derive(Parser)]
#[command(name = "mdw", version)]
struct Cli {
    /// Configuration file. Defaults to config.json beside the executable,
    /// then to the one in the source tree.
    #[arg(long, global = true, env = "MDW_CONFIG")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the workspace to a browser over local HTTP.
    Serve {
        /// The folder of notes.
        #[arg(default_value = ".")]
        workspace: PathBuf,
        /// Address to listen on; port 0 picks a free port.
        #[arg(long)]
        listen: Option<SocketAddr>,
        /// Open the workspace in the default browser.
        #[arg(long)]
        open: bool,
    },
    /// Open the workspace in a desktop window.
    #[cfg(feature = "desktop")]
    Desktop {
        /// The folder of notes.
        #[arg(default_value = ".")]
        workspace: PathBuf,
    },
    /// Print the OpenAPI document of the Rust API.
    Openapi {
        /// Write the document to this file instead.
        #[arg(long)]
        output: Option<PathBuf>,
    },
}

pub(crate) fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            workspace,
            listen,
            open,
        } => {
            let config = load_config(cli.config)?;
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(serve::run(
                    config,
                    ServeOptions {
                        workspace: &workspace,
                        listen,
                        open_browser: open,
                    },
                ))
        }
        #[cfg(feature = "desktop")]
        Command::Desktop { workspace } => crate::desktop::run(load_config(cli.config)?, &workspace),
        Command::Openapi { output } => {
            let document = openapi_document() + "\n";
            match output {
                Some(path) => std::fs::write(&path, document)
                    .with_context(|| format!("write {}", path.display())),
                None => {
                    print!("{document}");
                    Ok(())
                }
            }
        }
    }
}

fn load_config(explicit: Option<PathBuf>) -> Result<Config> {
    let path = explicit.unwrap_or_else(|| {
        let beside = std::env::current_exe()
            .ok()
            .and_then(|executable| {
                executable
                    .parent()
                    .map(|directory| directory.join("config.json"))
            })
            .filter(|path| path.is_file());
        beside.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config.json"))
    });
    Config::load(&path)
}
