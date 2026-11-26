//! `Server::isolation`: each instance of the server's application runs in a
//! child process, which stops JavaScript that never returns to the event
//! loop on every engine, Boa included, and is replaced for the next request.
//!
//! The server starts this test executable as the child, so `main` serves as
//! an isolated instance first and runs the test itself.

use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use fetchlet::{Isolation, Limits, ProcessOptions};
use fetchlet_http::Server;

/// A server module whose page shows the URL it was asked for, and whose
/// `/spin` page never returns.
const SERVER: &str = r#"
globalThis.fetchletExports = {
  render(request) {
    if (request.url.endsWith("/spin")) {
      for (;;) {}
    }
    const text = "<p>" + request.url + "</p>";
    return {
      status: 200,
      headers: [["content-type", "text/html; charset=utf-8"], ["content-length", String(text.length)]],
      body: Array.from(text, (c) => c.charCodeAt(0)),
    };
  },
};
"#;

fn main() -> std::process::ExitCode {
    fetchlet::serve_if_child();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let mut failed = false;
    for backend in ["quickjs", "boa", "v8"] {
        match runtime.block_on(serve_isolated(backend)) {
            Ok(()) => println!("test serves_isolated_instances ({backend}) ... ok"),
            Err(error) => {
                failed = true;
                println!("test serves_isolated_instances ({backend}) ... FAILED\n{error:?}");
            }
        }
    }
    if failed {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}

fn write_build(backend: &str) -> std::io::Result<PathBuf> {
    let directory = std::env::temp_dir().join(format!(
        "fetchlet-http-isolation-{}-{backend}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(directory.join("client"))?;
    std::fs::write(directory.join("server.js"), SERVER)?;
    std::fs::write(
        directory.join("fetchlet.json"),
        format!(
            r#"{{"format":"fetchlet-iife","formatVersion":1,"handler":"render","server":"server.js","client":"client","backend":"{backend}"}}"#
        ),
    )?;
    Ok(directory)
}

/// The status and body of a GET over a new connection.
async fn get_text(address: std::net::SocketAddr, path: &str) -> anyhow::Result<(u16, String)> {
    let mut stream = TcpStream::connect(address).await?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut response = String::new();
    stream.read_to_string(&mut response).await?;
    let status = response[9..12].parse()?;
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    Ok((status, body))
}

async fn serve_isolated(backend: &str) -> anyhow::Result<()> {
    let build = write_build(backend)?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel::<()>();
    // The server's default engine stack limits need its worker stack, which
    // the child's engine thread gets too.
    let server = Server::new(&build)
        .limits(Limits {
            busy_timeout: Some(Duration::from_millis(200)),
            ..Server::default_limits()
        })
        .isolation(Isolation::Process(ProcessOptions::new()));
    let serving = tokio::spawn(server.serve_with_shutdown(listener, async {
        let _ = stopped.await;
    }));

    let (status, page) = get_text(address, "/page").await?;
    anyhow::ensure!(
        status == 200 && page.contains("/page</p>"),
        "{status} {page}"
    );
    // Boa cannot stop this loop in-process; the server's child ends.
    let (status, _) = get_text(address, "/spin").await?;
    anyhow::ensure!(status != 200, "the spinning page answered {status}");
    // The pool replaces the stopped instance for the next request.
    let (status, page) = get_text(address, "/again").await?;
    anyhow::ensure!(
        status == 200 && page.contains("/again</p>"),
        "{status} {page}"
    );

    let _ = stop.send(());
    serving.await??;
    let _ = std::fs::remove_dir_all(build);
    Ok(())
}
