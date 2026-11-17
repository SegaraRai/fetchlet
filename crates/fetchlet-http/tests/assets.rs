//! Serving an asset archive that `fetchlet/build` wrote.
//!
//! tests/fixtures/embedded/assets.flpk comes from tools/fixtures/asset-archive.ts
//! (`vp run refresh:asset-archive`), so these tests read the Node writer's
//! output.

use std::convert::Infallible;
use std::io::Read;

use bytes::Bytes;
use http::{Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use tower::ServiceExt;

use fetchlet_http::{AssetArchive, AssetArchiveError, AssetService};

const ARCHIVE: &[u8] = include_bytes!("fixtures/embedded/assets.flpk");

fn archive() -> AssetArchive {
    AssetArchive::new(Bytes::from_static(ARCHIVE)).expect("the fixture archive is valid")
}

fn home() -> String {
    "<!doctype html><title>home</title>".to_owned() + &"<p>fetchlet</p>".repeat(64)
}

/// The response, with its body, from an asset service whose fallback
/// answers 404 "fallback".
async fn send(
    archive: AssetArchive,
    method: Method,
    uri: &str,
    headers: &[(&str, &str)],
) -> (http::response::Parts, Bytes) {
    let fallback = tower::service_fn(|_: Request<()>| async {
        let mut response = Response::new(Full::new(Bytes::from_static(b"fallback")));
        *response.status_mut() = StatusCode::NOT_FOUND;
        Ok::<_, Infallible>(response)
    });
    let mut request = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = AssetService::new(archive, fallback)
        .oneshot(request.body(()).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let body = body.collect().await.unwrap().to_bytes();
    (parts, body)
}

fn header<'a>(parts: &'a http::response::Parts, name: &str) -> Option<&'a str> {
    parts.headers.get(name).map(|value| value.to_str().unwrap())
}

fn brotli_decode(bytes: &[u8]) -> Vec<u8> {
    let mut raw = Vec::new();
    brotli_decompressor::Decompressor::new(bytes, 4096)
        .read_to_end(&mut raw)
        .unwrap();
    raw
}

#[tokio::test]
async fn brotli_clients_receive_the_stored_bytes() {
    let (parts, body) = send(
        archive(),
        Method::GET,
        "/index.html",
        &[("accept-encoding", "gzip, deflate, br, zstd")],
    )
    .await;
    assert_eq!(parts.status, StatusCode::OK);
    assert_eq!(header(&parts, "content-encoding"), Some("br"));
    assert_eq!(
        header(&parts, "content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(header(&parts, "vary"), Some("accept-encoding"));
    assert_eq!(
        header(&parts, "content-length"),
        Some(body.len().to_string().as_str())
    );
    assert!(header(&parts, "etag").unwrap().ends_with("-br\""));
    assert!(body.len() < home().len());
    assert_eq!(brotli_decode(&body), home().as_bytes());
}

#[tokio::test]
async fn other_clients_receive_decompressed_bytes() {
    let (parts, body) = send(
        archive(),
        Method::GET,
        "/index.html",
        &[("accept-encoding", "gzip, deflate")],
    )
    .await;
    assert_eq!(parts.status, StatusCode::OK);
    assert_eq!(header(&parts, "content-encoding"), None);
    assert_eq!(header(&parts, "vary"), Some("accept-encoding"));
    assert!(!header(&parts, "etag").unwrap().ends_with("-br\""));
    assert_eq!(body, home().as_bytes());
    // Brotli entries are served whole.
    assert_eq!(header(&parts, "accept-ranges"), None);
    let (ranged, body) = send(
        archive(),
        Method::GET,
        "/index.html",
        &[("range", "bytes=0-3")],
    )
    .await;
    assert_eq!(ranged.status, StatusCode::OK);
    assert_eq!(body, home().as_bytes());
}

#[tokio::test]
async fn matching_etags_answer_not_modified() {
    for encoding in ["br", "identity"] {
        let (parts, _) = send(
            archive(),
            Method::GET,
            "/_app/immutable/app.js",
            &[("accept-encoding", encoding)],
        )
        .await;
        let etag = header(&parts, "etag").unwrap().to_owned();
        let (parts, body) = send(
            archive(),
            Method::GET,
            "/_app/immutable/app.js",
            &[("accept-encoding", encoding), ("if-none-match", &etag)],
        )
        .await;
        assert_eq!(parts.status, StatusCode::NOT_MODIFIED);
        assert!(body.is_empty());
        assert_eq!(header(&parts, "etag"), Some(etag.as_str()));
        assert_eq!(
            header(&parts, "cache-control"),
            Some("public, max-age=31536000, immutable")
        );
    }
    // The other encoding's ETag does not match.
    let (parts, _) = send(archive(), Method::GET, "/_app/immutable/app.js", &[]).await;
    let identity = header(&parts, "etag").unwrap().to_owned();
    let (parts, _) = send(
        archive(),
        Method::GET,
        "/_app/immutable/app.js",
        &[("accept-encoding", "br"), ("if-none-match", &identity)],
    )
    .await;
    assert_eq!(parts.status, StatusCode::OK);
}

#[tokio::test]
async fn identity_entries_answer_single_ranges() {
    let (whole, body) = send(
        archive(),
        Method::GET,
        "/image.bin",
        &[("accept-encoding", "br")],
    )
    .await;
    assert_eq!(whole.status, StatusCode::OK);
    assert_eq!(body.len(), 1000);
    assert_eq!(header(&whole, "content-encoding"), None);
    assert_eq!(header(&whole, "vary"), None);
    assert_eq!(header(&whole, "accept-ranges"), Some("bytes"));
    assert_eq!(
        header(&whole, "content-type"),
        Some("application/octet-stream")
    );

    let (parts, part) = send(
        archive(),
        Method::GET,
        "/image.bin",
        &[("range", "bytes=10-19")],
    )
    .await;
    assert_eq!(parts.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(header(&parts, "content-range"), Some("bytes 10-19/1000"));
    assert_eq!(part, body.slice(10..20));

    let (parts, part) = send(
        archive(),
        Method::GET,
        "/image.bin",
        &[("range", "bytes=1000-")],
    )
    .await;
    assert_eq!(parts.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(header(&parts, "content-range"), Some("bytes */1000"));
    assert!(part.is_empty());

    let (parts, _) = send(
        archive(),
        Method::GET,
        "/image.bin",
        &[("range", "bytes=0-1,5-6")],
    )
    .await;
    assert_eq!(parts.status, StatusCode::OK);
}

#[tokio::test]
async fn head_describes_the_get_response_without_a_body() {
    let (get, get_body) = send(
        archive(),
        Method::GET,
        "/index.html",
        &[("accept-encoding", "br")],
    )
    .await;
    let (head, body) = send(
        archive(),
        Method::HEAD,
        "/index.html",
        &[("accept-encoding", "br")],
    )
    .await;
    assert_eq!(head.status, StatusCode::OK);
    assert!(body.is_empty());
    assert_eq!(
        header(&head, "content-length"),
        Some(get_body.len().to_string().as_str())
    );
    assert_eq!(head.headers, get.headers);
}

#[tokio::test]
async fn directory_indexes_follow_serve_dir() {
    let (root, body) = send(archive(), Method::GET, "/", &[]).await;
    assert_eq!(root.status, StatusCode::OK);
    assert_eq!(body, home().as_bytes());

    let (docs, body) = send(archive(), Method::GET, "/docs/", &[]).await;
    assert_eq!(docs.status, StatusCode::OK);
    assert!(body.starts_with(b"<!doctype html><title>docs</title>"));

    let (redirect, body) = send(archive(), Method::GET, "/docs?tab=1", &[]).await;
    assert_eq!(redirect.status, StatusCode::PERMANENT_REDIRECT);
    // Generated redirects keep the request's query.
    assert_eq!(header(&redirect, "location"), Some("/docs/?tab=1"));
    assert!(body.is_empty());
}

#[tokio::test]
async fn stored_responses_keep_their_status_and_headers() {
    let (parts, body) = send(archive(), Method::GET, "/old.html?x=1", &[]).await;
    assert_eq!(parts.status, StatusCode::MOVED_PERMANENTLY);
    // Stored responses keep their Location as written.
    assert_eq!(header(&parts, "location"), Some("/"));
    assert_eq!(header(&parts, "etag"), None);
    assert!(body.is_empty());

    let (parts, body) = send(archive(), Method::GET, "/caf%C3%A9.txt", &[]).await;
    assert_eq!(parts.status, StatusCode::OK);
    assert_eq!(body, "unicode path");
    let cookies: Vec<_> = parts.headers.get_all("set-cookie").iter().collect();
    assert_eq!(cookies, ["a=1", "b=2"]);
}

#[tokio::test]
async fn other_methods_and_paths_reach_the_fallback() {
    for (method, uri) in [
        (Method::POST, "/index.html"),
        (Method::GET, "/missing.js"),
        (Method::GET, "/index.html/"),
        (Method::GET, "/%zz"),
        (Method::GET, "/INDEX.HTML"),
    ] {
        let (parts, body) = send(archive(), method, uri, &[]).await;
        assert_eq!(parts.status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(body, "fallback");
    }
}

#[test]
fn the_archive_indexes_every_served_path() {
    let archive = archive();
    assert_eq!(archive.len(), 9);
    let app = archive.get("/_app/immutable/app.js").unwrap();
    assert!(app.is_brotli());
    assert_eq!(
        app.decompressed().unwrap(),
        "export const message = 'fetchlet';\n".repeat(64)
    );
    assert!(!archive.get("/image.bin").unwrap().is_brotli());
    assert!(archive.get("/nope").is_none());
}

#[test]
fn malformed_archives_are_refused_without_panicking() {
    assert!(matches!(
        AssetArchive::new(Bytes::from_static(b"NOPE")),
        Err(AssetArchiveError::Invalid(_))
    ));
    let mut wrong_magic = ARCHIVE.to_vec();
    wrong_magic[0] = b'X';
    assert!(matches!(
        AssetArchive::new(wrong_magic),
        Err(AssetArchiveError::Magic)
    ));
    let mut future = ARCHIVE.to_vec();
    future[4] = 2;
    assert!(matches!(
        AssetArchive::new(future),
        Err(AssetArchiveError::Version(2))
    ));

    // Every truncation inside the indexed sections is refused.
    for length in 0..ARCHIVE.len() {
        if let Ok(archive) = AssetArchive::new(ARCHIVE[..length].to_vec()) {
            panic!(
                "a {length}-byte prefix was accepted with {} entries",
                archive.len()
            );
        }
    }
    // Any single corrupted byte either is refused or still serves without
    // panicking; corrupt Brotli data fails to decompress.
    for index in 0..ARCHIVE.len() {
        let mut bytes = ARCHIVE.to_vec();
        bytes[index] ^= 0xa5;
        if let Ok(archive) = AssetArchive::new(bytes) {
            for path in ["/", "/index.html", "/image.bin", "/old.html", "/docs"] {
                if let Some(asset) = archive.get(path) {
                    let _ = asset.decompressed();
                    let _ = asset.headers().count();
                }
            }
        }
    }
}

#[tokio::test]
async fn corrupt_brotli_data_answers_a_server_error() {
    let archive = archive();
    let asset = archive.get("/_app/immutable/app.js").unwrap();
    // Locate the stored bytes and damage them.
    let stored = asset.stored();
    let offset = ARCHIVE
        .windows(stored.len())
        .position(|window| window == &stored[..])
        .unwrap();
    let mut bytes = ARCHIVE.to_vec();
    for byte in &mut bytes[offset..offset + stored.len()] {
        *byte = 0xff;
    }
    let damaged = AssetArchive::new(bytes).unwrap();
    let (parts, body) = send(damaged.clone(), Method::GET, "/_app/immutable/app.js", &[]).await;
    assert_eq!(parts.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.is_empty());
    // Brotli clients still receive the stored bytes; their decoder reports it.
    let (parts, _) = send(
        damaged,
        Method::GET,
        "/_app/immutable/app.js",
        &[("accept-encoding", "br")],
    )
    .await;
    assert_eq!(parts.status, StatusCode::OK);
}
