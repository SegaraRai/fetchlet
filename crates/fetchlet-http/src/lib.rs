//! Serve shared fetchlet applications over HTTP.
//!
//! [`FetchletService`] is a Tower service over `http` 1 types and is always
//! available. The `hyper`, `axum` and `actix` features add thin integrations
//! for those servers. [`Artifact`] reads the output of `@fetchlet/build`.
//! The JavaScript engine is chosen on the `fetchlet` crate.

mod artifact;
mod service;

#[cfg(feature = "actix")]
mod actix_server;
#[cfg(feature = "axum")]
mod axum_server;
#[cfg(feature = "hyper")]
mod hyper_server;

pub use artifact::{Artifact, ArtifactError};
pub use service::{
    BoxError, Error, FetchletService, PublicOrigin, RequestContext, service_transport,
};

#[cfg(feature = "actix")]
pub use actix_server::ActixService;
#[cfg(feature = "axum")]
pub use axum_server::{AxumService, artifact_router, connect_info, router_transport};
#[cfg(feature = "hyper")]
pub use hyper_server::{HyperConnection, HyperService, PeerAddr, peer_addr};
