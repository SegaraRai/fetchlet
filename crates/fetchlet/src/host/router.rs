use std::collections::BTreeMap;
use std::sync::Arc;

use super::policy::{normalize_origin, parse_url};
use super::{Context, FetchPolicy, FetchService, FetchTransport, TransportFuture};
use crate::{Error, Request, Result};

struct Route {
    transport: Arc<dyn FetchTransport>,
    /// Whether this route receives the invocation's [`Context`].
    trusted: bool,
}

/// Exact-origin routing of host fetches to registered transports.
///
/// Every request, including each redirect hop, is classified by its normalized
/// origin after any rewrite. A registered origin goes to its transport only;
/// an unregistered origin is denied, never passed to another route. Statuses
/// such as 404 or 500 from a route are its responses, and its errors reject
/// the fetch.
///
/// Internal routes, typically in-process Rust handlers, receive the invocation
/// [`Context`]. External routes, typically a network client, never do,
/// including after a redirect from an internal route.
#[derive(Clone, Default)]
pub struct OriginRouter {
    routes: BTreeMap<String, Arc<Route>>,
}

impl OriginRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Route an origin to a trusted transport that receives the [`Context`].
    pub fn internal(self, origin: &str, transport: impl FetchTransport) -> Result<Self> {
        self.route(origin, Arc::new(transport), true)
    }

    /// Route an origin to a transport that does not receive the [`Context`].
    pub fn external(self, origin: &str, transport: impl FetchTransport) -> Result<Self> {
        self.route(origin, Arc::new(transport), false)
    }

    fn route(
        mut self,
        origin: &str,
        transport: Arc<dyn FetchTransport>,
        trusted: bool,
    ) -> Result<Self> {
        let origin = normalize_origin(origin)?;
        if self.routes.contains_key(&origin) {
            return Err(Error::Configuration("duplicate routed origin".into()));
        }
        self.routes
            .insert(origin, Arc::new(Route { transport, trusted }));
        Ok(self)
    }

    /// A fetch service whose policy admits exactly the registered origins.
    pub fn into_service(self) -> FetchService {
        let policy = FetchPolicy::from_origins(self.routes.keys().cloned());
        FetchService::new(self, policy).forward_context()
    }
}

impl FetchTransport for OriginRouter {
    fn send(&self, mut request: Request) -> TransportFuture {
        let route = parse_url(&request.uri().to_string())
            .ok()
            .and_then(|url| self.routes.get(&url.origin().ascii_serialization()))
            .cloned();
        let Some(route) = route else {
            return Box::pin(async { Err(Error::PermissionDenied) });
        };
        if !route.trusted {
            request.extensions_mut().remove::<Context>();
        }
        route.transport.send(request)
    }
}
