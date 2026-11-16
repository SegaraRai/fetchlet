use axum::Router;

use fetchlet::FetchTransport;

/// Serve host fetches with an axum `Router`.
///
/// This is [`fetchlet_tower::service_transport`] for a router: register it
/// with [`fetchlet::OriginRouter::internal`] to share one router between
/// public HTTP and in-process fetches. Handlers read the trusted Context with
/// `Option<Extension<fetchlet::Context>>`.
pub fn router_transport(router: Router) -> impl FetchTransport {
    fetchlet_tower::service_transport(router)
}
