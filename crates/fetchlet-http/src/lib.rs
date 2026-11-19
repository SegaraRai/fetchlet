//! Serve shared fetchlet applications over HTTP.
//!
//! [`FetchletService`] is a Tower service over `http` 1 types and is always
//! available. The `hyper`, `axum` and `actix` features add thin integrations
//! for those servers. [`Artifact`] reads the output of `fetchlet/build`, and
//! [`AssetService`] serves its client assets from an [`AssetArchive`].
//! The `dev` feature adds `DevReload`, which serves an artifact while a
//! build tool rewrites it, and the `vite-dev` feature adds `ViteDev`, which
//! runs the server module from a Vite dev server through Vite's module runner.
//! The JavaScript engine is chosen on the `fetchlet` crate.

mod artifact;
mod assets;
mod service;

#[cfg(feature = "actix")]
mod actix_server;
#[cfg(feature = "axum")]
mod axum_server;
#[cfg(feature = "dev")]
mod dev;
#[cfg(feature = "hyper")]
mod hyper_server;
#[cfg(feature = "vite-dev")]
mod vite_dev;

pub use artifact::{Artifact, ArtifactError};
pub use assets::{Asset, AssetArchive, AssetArchiveError, AssetBody, AssetFuture, AssetService};
pub use service::{
    BoxError, Error, FetchletService, PublicOrigin, RequestContext, service_transport,
};

#[cfg(feature = "actix")]
pub use actix_server::ActixService;
#[cfg(feature = "axum")]
pub use axum_server::{AxumService, artifact_router, connect_info, router_transport};
#[cfg(feature = "dev")]
pub use dev::{
    DevBody, DevReload, DevReloadBuilder, DevService, Generation, RELOAD_POLL_PATH,
    RELOAD_SCRIPT_PATH, ReloadError,
};
#[cfg(feature = "hyper")]
pub use hyper_server::{HyperConnection, HyperService, PeerAddr, peer_addr};
#[cfg(feature = "vite-dev")]
pub use vite_dev::{VITE_BINDING, ViteBody, ViteDev, ViteDevError, ViteProxy};

#[doc(hidden)]
pub mod __private {
    pub use bytes::Bytes;
}
