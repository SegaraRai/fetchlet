//! Serve shared fetchlet applications over HTTP.
//!
//! [`FetchletService`] is a Tower service over `http` 1 types and is always
//! available. The `hyper`, `axum` and `actix` features add thin integrations
//! for those servers; with `axum`, `Server` serves one build behind Rust
//! routes in a few lines. [`Artifact`] reads the output of `fetchlet/build`, and
//! [`AssetService`] serves its client assets from an [`AssetArchive`].
//! [`WebviewResponder`] answers a webview's custom URI scheme, such as
//! Tauri's, in-process with any of these services.
//! The `dev` feature adds `DevReload`, which serves an artifact while a
//! build tool rewrites it, and the `vite-dev` feature adds `ViteDev`, which
//! runs the server module from a Vite dev server through Vite's module runner.
//! The `sockets` feature adds `TcpTransport`, which opens the TCP and TLS
//! connections of JavaScript's `connect()` for a `SocketService`.
//! The JavaScript engine is chosen on the `fetchlet` crate.

mod artifact;
mod assets;
mod service;
mod webview;

#[cfg(feature = "actix")]
mod actix_server;
#[cfg(feature = "axum")]
mod axum_server;
#[cfg(feature = "dev")]
mod dev;
#[cfg(feature = "hyper")]
mod hyper_server;
#[cfg(feature = "sockets")]
mod socket;
#[cfg(feature = "vite-dev")]
mod vite_dev;

pub use artifact::{Artifact, ArtifactError};
pub use assets::{Asset, AssetArchive, AssetArchiveError, AssetBody, AssetFuture, AssetService};
pub use service::{
    BoxError, Error, FetchletService, PublicOrigin, RequestContext, service_transport,
};
pub use webview::{WebviewResponder, WebviewScheme};

#[cfg(feature = "actix")]
pub use actix_server::ActixService;
#[cfg(feature = "axum")]
pub use axum_server::{AxumService, artifact_router, connect_info, router_transport};
#[cfg(all(feature = "axum", fetchlet_engine))]
pub use axum_server::{Server, ServerError, VITE_URL_VARIABLE, Webview};
#[cfg(feature = "dev")]
pub use dev::{
    DevBody, DevReload, DevReloadBuilder, DevService, Generation, RELOAD_POLL_PATH,
    RELOAD_SCRIPT_PATH, ReloadError, Reloads,
};
#[cfg(feature = "hyper")]
pub use hyper_server::{HyperConnection, HyperService, PeerAddr, peer_addr};
#[cfg(feature = "sockets")]
pub use socket::{TcpTransport, rustls};
#[cfg(feature = "vite-dev")]
pub use vite_dev::{VITE_BINDING, ViteBody, ViteDev, ViteDevError, ViteProxy};

#[doc(hidden)]
pub mod __private {
    pub use bytes::Bytes;
}
