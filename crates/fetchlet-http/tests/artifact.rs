//! Reading build artifacts and serving their client assets with axum.

use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::{Body, to_bytes};
use axum::http::Request;
use tower::ServiceExt;

use fetchlet::{App, Backend, Module, WorkerOptions};
use fetchlet_http::{Artifact, ArtifactError, AxumService, artifact_router};

/// Answers with the request URL, from the export the manifest names.
const SERVER: &str = r#"
globalThis.fetchletExports = {
  render(request) {
    const text = "rendered " + request.url;
    return { status: 200, headers: [], body: Array.from(text, (c) => c.charCodeAt(0)) };
  },
};
"#;

/// A fresh directory holding `fetchlet.json` and the given files.
fn artifact_directory(manifest: &str, files: &[(&str, &str)]) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let directory = std::env::temp_dir().join(format!(
        "fetchlet-http-artifact-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("fetchlet.json"), manifest).unwrap();
    for (name, contents) in files {
        let path = directory.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    directory
}

fn manifest(server: &str, client: &str) -> String {
    format!(
        r#"{{"format":"fetchlet-iife","formatVersion":1,"handler":"render",
        "server":"{server}","client":"{client}","backend":"quickjs","framework":"test"}}"#
    )
}

async fn text(router: axum::Router, method: &str, uri: &str) -> anyhow::Result<(u16, String)> {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())?;
    let response = router.oneshot(request).await?;
    let status = response.status().as_u16();
    let body = to_bytes(response.into_body(), 1024).await?;
    Ok((status, String::from_utf8(body.to_vec())?))
}

#[test]
fn the_manifest_names_the_server_module_and_client_assets() -> anyhow::Result<()> {
    let directory = artifact_directory(
        &manifest("server.js", "client"),
        &[("server.js", SERVER), ("client/app.css", "body{}")],
    );
    let artifact = Artifact::open(&directory)?;
    assert_eq!(artifact.handler(), "render");
    assert_eq!(artifact.backend(), Some("quickjs"));
    assert_eq!(artifact.server_source()?, SERVER);
    assert_eq!(artifact.client_directory(), Some(directory.join("client")));
    Ok(())
}

#[test]
fn manifests_cannot_leave_the_artifact_or_change_format() {
    for server in ["../server.js", "/etc/server.js", "nested/../../server.js"] {
        let directory = artifact_directory(&manifest(server, "client"), &[]);
        let error = Artifact::open(&directory).unwrap_err();
        assert!(
            matches!(error, ArtifactError::Unsupported { .. }),
            "{server}: {error}"
        );
    }
    let directory = artifact_directory(&manifest("server.js", "../public"), &[]);
    assert!(matches!(
        Artifact::open(&directory),
        Err(ArtifactError::Unsupported { .. })
    ));

    let directory = artifact_directory(
        r#"{"format":"fetchlet-iife","formatVersion":2,"handler":"handle","server":"server.js"}"#,
        &[],
    );
    assert!(matches!(
        Artifact::open(&directory),
        Err(ArtifactError::Unsupported { .. })
    ));
    let directory = artifact_directory("{", &[]);
    assert!(matches!(
        Artifact::open(&directory),
        Err(ArtifactError::Manifest { .. })
    ));
    let missing = std::env::temp_dir().join("fetchlet-http-artifact-missing");
    assert!(matches!(
        Artifact::open(missing),
        Err(ArtifactError::Read { .. })
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn client_assets_are_served_before_the_application() -> anyhow::Result<()> {
    let directory = artifact_directory(
        &manifest("server.js", "client"),
        &[("server.js", SERVER), ("client/assets/app.css", "body{}")],
    );
    std::fs::write(directory.join("private.txt"), "private")?;
    let artifact = Artifact::open(&directory)?;
    let app = App::builder(Backend::quickjs())
        .module(Module::new(artifact.server_source()?))
        .fetch_handler(artifact.handler())
        .spawn(WorkerOptions::new(NonZeroUsize::MIN))
        .await?;
    let router = artifact_router(
        &artifact,
        AxumService::new(app.clone(), "https://app.test")?,
    );

    assert_eq!(
        text(router.clone(), "GET", "/assets/app.css").await?,
        (200, "body{}".into())
    );
    // Other methods and missing files reach the application.
    assert_eq!(
        text(router.clone(), "POST", "/assets/app.css").await?,
        (200, "rendered https://app.test/assets/app.css".into())
    );
    assert_eq!(
        text(router.clone(), "GET", "/about?x=1").await?,
        (200, "rendered https://app.test/about?x=1".into())
    );
    // Files outside the client directory are not served.
    for path in [
        "/../private.txt",
        "/%2e%2e/private.txt",
        "/..%2fprivate.txt",
    ] {
        let (_, body) = text(router.clone(), "GET", path).await?;
        assert_ne!(body, "private", "{path}");
    }
    app.shutdown().await?;
    Ok(())
}
