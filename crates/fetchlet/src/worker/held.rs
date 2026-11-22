use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// A place among the [`Instances::max_held_connections`](super::Instances::max_held_connections)
/// of an [`AppHandle`](crate::AppHandle), from
/// [`AppHandle::reserve_connection`](crate::AppHandle::reserve_connection).
///
/// An HTTP integration reserves one for a WebSocket upgrade request before
/// JavaScript runs and puts it in the request's extensions. The handler may
/// then accept the upgrade; the place is held until the connection closes,
/// and returns to the pool when the request ends without an upgrade.
#[derive(Clone)]
pub struct HeldConnection {
    _permit: Arc<OwnedSemaphorePermit>,
}

impl HeldConnection {
    pub(super) fn try_reserve(places: &Arc<Semaphore>) -> Option<Self> {
        places.clone().try_acquire_owned().ok().map(|permit| Self {
            _permit: Arc::new(permit),
        })
    }
}

impl std::fmt::Debug for HeldConnection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HeldConnection")
            .finish_non_exhaustive()
    }
}
