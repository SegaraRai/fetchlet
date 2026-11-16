use std::fmt;

/// Trusted, request-scoped values that Rust supplies to in-process services.
///
/// Attach a `Context` to the extensions of the request passed to `App::fetch`
/// (or `AppHandle::fetch`). Each host fetch of that invocation then carries a
/// clone in its request extensions, for services that accept it: routes
/// registered with [`OriginRouter::internal`](crate::OriginRouter::internal)
/// or a [`FetchService`](crate::FetchService) configured with
/// `forward_context`. JavaScript cannot read, create or replace it, and
/// request headers never populate it.
#[derive(Clone, Default)]
pub struct Context {
    values: http::Extensions,
}

impl Context {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a value, returning the previous value of the same type.
    pub fn insert<T: Clone + Send + Sync + 'static>(&mut self, value: T) -> Option<T> {
        self.values.insert(value)
    }

    /// Add a value, builder style.
    pub fn with<T: Clone + Send + Sync + 'static>(mut self, value: T) -> Self {
        self.values.insert(value);
        self
    }

    pub fn get<T: Send + Sync + 'static>(&self) -> Option<&T> {
        self.values.get::<T>()
    }

    /// The context carried by a request's extensions, if any.
    pub fn of<B>(request: &http::Request<B>) -> Option<&Self> {
        request.extensions().get::<Self>()
    }
}

impl fmt::Debug for Context {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Values are application secrets as far as fetchlet knows.
        formatter.debug_struct("Context").finish_non_exhaustive()
    }
}
