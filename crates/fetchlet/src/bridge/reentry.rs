//! Detection of calls from a host fetch back into the application running it.
//!
//! A worker runs one invocation at a time, and that invocation waits for its
//! host fetches. A host fetch that calls the same worker would wait for the
//! invocation to finish, which waits for the host fetch. Host futures are
//! polled on the worker thread inside [`enter`], so a call made while one is
//! being polled can be refused at once.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_KEY: AtomicU64 = AtomicU64::new(1);

thread_local! {
    /// Applications whose host futures this thread is polling, innermost last.
    static POLLING: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

/// A new application identity, shared by the instances a worker recreates.
#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    allow(dead_code)
)]
pub(crate) fn new_key() -> u64 {
    NEXT_KEY.fetch_add(1, Ordering::Relaxed)
}

/// Whether the current thread is polling host futures of `key`.
#[cfg_attr(
    not(any(feature = "boa", feature = "quickjs", feature = "v8")),
    allow(dead_code)
)]
pub(crate) fn is_polling(key: u64) -> bool {
    POLLING.with(|polling| polling.borrow().contains(&key))
}

/// Mark the host futures of `key` as being polled until the guard drops.
pub(super) fn enter(key: u64) -> Polling {
    POLLING.with(|polling| polling.borrow_mut().push(key));
    Polling { key }
}

pub(super) struct Polling {
    key: u64,
}

impl Drop for Polling {
    fn drop(&mut self) {
        POLLING.with(|polling| {
            let mut polling = polling.borrow_mut();
            if let Some(index) = polling.iter().rposition(|key| *key == self.key) {
                polling.remove(index);
            }
        });
    }
}
